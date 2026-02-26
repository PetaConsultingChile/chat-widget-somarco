/* decision-chat-widget.js */
(function () {
  function initializeWidget() {
    // ----------------------------
    // 1) Config
    // ----------------------------
    const widgetConfig = {
      apiUrl:
        "https://raw.githubusercontent.com/PetaConsultingChile/decision-chat-widget/refs/heads/main/decision-tree.json",
      initialTree: null,
      updateInterval: 10000,
      customActions: {},
      customRenderer: null,

      // Chat API (server history)
      chatApiBaseUrl: "", // ej: "https://api.tudominio.com"
      chatGetPath: "/chat/messages",
      chatSendPath: "/chat/messages",
      threadId: null,
      chatHeaders: {},
      useServerHistory: true,

      // Estado inicial del árbol
      initialNode: "start",
      storageKeyPrefix: "decision-chat",
    };

    function loadConfigFromHTML() {
      const script =
        document.currentScript ||
        document.querySelector('script[src*="widget.js"]') ||
        document.querySelector('script[src*="decision-chat-widget"]');

      if (script) {
        const apiUrl = script.getAttribute("data-api-url");
        const updateInterval = script.getAttribute("data-update-interval");

        const chatApiBaseUrl = script.getAttribute("data-chat-api-base-url");
        const chatGetPath = script.getAttribute("data-chat-get-path");
        const chatSendPath = script.getAttribute("data-chat-send-path");
        const threadId = script.getAttribute("data-thread-id");

        const useServerHistory = script.getAttribute("data-use-server-history");

        if (apiUrl) widgetConfig.apiUrl = apiUrl;
        if (updateInterval)
          widgetConfig.updateInterval =
            parseInt(updateInterval, 10) || widgetConfig.updateInterval;

        if (chatApiBaseUrl) widgetConfig.chatApiBaseUrl = chatApiBaseUrl;
        if (chatGetPath) widgetConfig.chatGetPath = chatGetPath;
        if (chatSendPath) widgetConfig.chatSendPath = chatSendPath;
        if (threadId) widgetConfig.threadId = threadId;

        // permite "true"/"false"
        if (useServerHistory != null)
          widgetConfig.useServerHistory = useServerHistory === "true";
      }

      if (
        window.decisionChatConfig &&
        typeof window.decisionChatConfig === "object"
      ) {
        Object.assign(widgetConfig, window.decisionChatConfig);
      }
    }

    // ----------------------------
    // 2) Estado
    // ----------------------------
    let decisionTree = widgetConfig.initialTree; // { [nodeId]: { message, options[] } }
    let currentNode = widgetConfig.initialNode;
    let history = [];
    let isOpen = false;

    const storage = {
      key(suffix) {
        return `${widgetConfig.storageKeyPrefix}:${suffix}`;
      },
      load() {
        try {
          const raw = localStorage.getItem(this.key("state"));
          if (!raw) return null;
          return JSON.parse(raw);
        } catch {
          return null;
        }
      },
      save(state) {
        try {
          localStorage.setItem(this.key("state"), JSON.stringify(state));
        } catch {}
      },
      loadThreadId() {
        try {
          return localStorage.getItem(this.key("threadId"));
        } catch {
          return null;
        }
      },
      saveThreadId(id) {
        try {
          localStorage.setItem(this.key("threadId"), id);
        } catch {}
      },
    };

    function getOrCreateThreadId() {
      if (widgetConfig.threadId) return widgetConfig.threadId;

      const saved = storage.loadThreadId();
      if (saved) return saved;

      const id =
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

      storage.saveThreadId(id);
      return id;
    }

    function saveState() {
      storage.save({ currentNode, history });
    }

    function loadState() {
      const st = storage.load();
      if (!st) return;
      if (typeof st.currentNode === "string") currentNode = st.currentNode;
      if (Array.isArray(st.history)) history = st.history;
    }

    // ----------------------------
    // 3) Helpers HTTP
    // ----------------------------
    function buildChatUrl(path) {
      const base = (widgetConfig.chatApiBaseUrl || "").replace(/\/+$/, "");
      const p = (path || "").startsWith("/") ? path : `/${path}`;
      return `${base}${p}`;
    }

    async function loadTreeFromRemote() {
      if (widgetConfig.initialTree) {
        decisionTree = widgetConfig.initialTree;
        return decisionTree;
      }
      const res = await fetch(widgetConfig.apiUrl, {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) throw new Error(`Decision tree fetch failed: ${res.status}`);
      const json = await res.json();
      decisionTree = json;
      return decisionTree;
    }

    // Polling para árbol remoto (si cambia en GitHub, por ejemplo)
    function initializeDynamicTree() {
      if (!widgetConfig.apiUrl) return;
      if (!widgetConfig.updateInterval || widgetConfig.updateInterval <= 0)
        return;

      setInterval(async () => {
        try {
          const res = await fetch(widgetConfig.apiUrl, {
            headers: { Accept: "application/json" },
          });
          if (!res.ok) return;

          const newTree = await res.json();

          // reemplaza si cambió (simple: compara string)
          const oldStr = JSON.stringify(decisionTree || {});
          const newStr = JSON.stringify(newTree || {});
          if (newStr !== oldStr) {
            decisionTree = newTree;

            // si el nodo actual ya no existe, vuelve al start
            if (!decisionTree[currentNode])
              currentNode = widgetConfig.initialNode;

            // re-render si está abierto
            if (isOpen) {
              renderMessages();
              renderOptions();
            }
          }
        } catch (e) {
          // silencio: no rompas el widget por fallos de red
        }
      }, widgetConfig.updateInterval);
    }

    async function loadMessagesFromAPI() {
      if (!widgetConfig.chatApiBaseUrl || !widgetConfig.useServerHistory)
        return false;

      const threadId = getOrCreateThreadId();
      const url = new URL(buildChatUrl(widgetConfig.chatGetPath));
      url.searchParams.set("threadId", threadId);

      try {
        const res = await fetch(url.toString(), {
          method: "GET",
          headers: {
            Accept: "application/json",
            ...(widgetConfig.chatHeaders || {}),
          },
        });

        if (!res.ok) throw new Error(`GET messages failed: ${res.status}`);

        const data = await res.json();
        const serverMsgs = Array.isArray(data.data) ? data.data : [];

        history = serverMsgs.map((m) => ({
          text: String(m.text || ""),
          from:
            (m.from || m.role) === "assistant" || (m.from || m.role) === "bot"
              ? "bot"
              : "user",
        }));

        // opcional: si tu API devuelve nodo actual
        if (typeof data.currentNode === "string")
          currentNode = data.currentNode;

        renderMessages();
        saveState();
        return true;
      } catch (err) {
        console.warn("Error loading messages from API:", err);
        return false;
      }
    }

    async function sendMessageToAPI(text, meta) {
      if (!widgetConfig.chatApiBaseUrl) return false;

      const threadId = getOrCreateThreadId();
      const url = buildChatUrl(widgetConfig.chatSendPath);

      try {
        setSending(true); // ✅ show typing

        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            ...(widgetConfig.chatHeaders || {}),
          },
          body: JSON.stringify({
            threadId,
            text,
            meta: meta || null,
            currentNode,
          }),
        });

        if (!res.ok) throw new Error(`POST message failed: ${res.status}`);

        if (widgetConfig.useServerHistory) {
          await loadMessagesFromAPI();
        }

        return true;
      } catch (err) {
        console.warn("Error sending message to API:", err);

        // opcional: mensaje visible
        addMessage("No pude enviar el mensaje. Intenta de nuevo.", "bot");
        return false;
      } finally {
        setSending(false); // ✅ hide typing
      }
    }

    // ----------------------------
    // 4) UI mínima (puedes reemplazar por tu renderer)
    // ----------------------------
    const root = document.createElement("div");
    root.id = "decision-chat-widget-root";
    root.style.position = "fixed";
    root.style.right = "16px";
    root.style.bottom = "16px";
    root.style.zIndex = "999999";

    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Chat";
    button.style.padding = "10px 14px";
    button.style.borderRadius = "12px";
    button.style.border = "1px solid rgba(0,0,0,0.12)";
    button.style.background = "white";
    button.style.cursor = "pointer";

    const panel = document.createElement("div");
    panel.style.width = "320px";
    panel.style.height = "420px";
    panel.style.marginTop = "10px";
    panel.style.borderRadius = "14px";
    panel.style.border = "1px solid rgba(0,0,0,0.12)";
    panel.style.background = "white";
    panel.style.display = "none";
    panel.style.overflow = "hidden";
    panel.style.boxShadow = "0 10px 30px rgba(0,0,0,0.10)";

    const header = document.createElement("div");
    header.style.padding = "10px 12px";
    header.style.borderBottom = "1px solid rgba(0,0,0,0.08)";
    header.style.display = "flex";
    header.style.justifyContent = "space-between";
    header.style.alignItems = "center";
    header.innerHTML = `<strong>Decision Chat</strong>`;

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.textContent = "×";
    closeBtn.style.border = "none";
    closeBtn.style.background = "transparent";
    closeBtn.style.cursor = "pointer";
    closeBtn.style.fontSize = "18px";

    header.appendChild(closeBtn);

    const messagesEl = document.createElement("div");
    messagesEl.style.padding = "12px";
    messagesEl.style.height = "240px";
    messagesEl.style.overflowY = "auto";
    messagesEl.style.display = "flex";
    messagesEl.style.flexDirection = "column";
    messagesEl.style.gap = "8px";

    const typingEl = document.createElement("div");
    typingEl.style.padding = "0 12px 8px 12px";
    typingEl.style.fontSize = "12px";
    typingEl.style.opacity = "0.7";
    typingEl.style.display = "none";
    typingEl.style.userSelect = "none";
    typingEl.textContent = "Escribiendo…";

    const optionsEl = document.createElement("div");
    optionsEl.style.padding = "12px";
    optionsEl.style.borderTop = "1px solid rgba(0,0,0,0.08)";
    optionsEl.style.display = "flex";
    optionsEl.style.flexWrap = "wrap";
    optionsEl.style.gap = "8px";

    const composerEl = document.createElement("div");
    composerEl.style.padding = "12px";
    composerEl.style.borderTop = "1px solid rgba(0,0,0,0.08)";
    composerEl.style.display = "flex";
    composerEl.style.gap = "8px";
    composerEl.style.alignItems = "center";

    const inputEl = document.createElement("input");
    inputEl.type = "text";
    inputEl.placeholder = "Escribe tu mensaje…";
    inputEl.style.flex = "1";
    inputEl.style.padding = "10px 12px";
    inputEl.style.borderRadius = "10px";
    inputEl.style.border = "1px solid rgba(0,0,0,0.12)";
    inputEl.style.fontSize = "13px";
    inputEl.style.outline = "none";

    const sendBtn = document.createElement("button");
    sendBtn.type = "button";
    sendBtn.textContent = "Enviar";
    sendBtn.style.padding = "10px 12px";
    sendBtn.style.borderRadius = "10px";
    sendBtn.style.border = "1px solid rgba(0,0,0,0.12)";
    sendBtn.style.background = "white";
    sendBtn.style.cursor = "pointer";
    sendBtn.style.fontSize = "13px";

    panel.appendChild(header);
    panel.appendChild(messagesEl);
    panel.appendChild(typingEl);
    panel.appendChild(optionsEl);
    panel.appendChild(composerEl);

    composerEl.appendChild(inputEl);
    composerEl.appendChild(sendBtn);

    root.appendChild(button);
    root.appendChild(panel);
    document.body.appendChild(root);

    function scrollToBottom() {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    let isSending = false;

    function setSending(state) {
      isSending = state;

      typingEl.style.display = state ? "block" : "none";

      // UX: bloquear input/botón mientras responde
      inputEl.disabled = state;
      sendBtn.disabled = state;

      sendBtn.style.opacity = state ? "0.6" : "1";
      inputEl.style.opacity = state ? "0.85" : "1";

      if (state) scrollToBottom();
    }

    function addMessage(text, from) {
      const msg = {
        text: String(text || ""),
        from: from === "bot" ? "bot" : "user",
      };
      history.push(msg);
      renderMessages();
      saveState();
    }

    function renderMessages() {
      // custom renderer hook
      if (typeof widgetConfig.customRenderer === "function") {
        widgetConfig.customRenderer({
          root,
          panel,
          messagesEl,
          optionsEl,
          history,
          currentNode,
          decisionTree,
          addMessage,
        });
        return;
      }

      messagesEl.innerHTML = "";
      for (const m of history) {
        const bubble = document.createElement("div");
        bubble.textContent = m.text;
        bubble.style.padding = "10px 12px";
        bubble.style.borderRadius = "12px";
        bubble.style.maxWidth = "85%";
        bubble.style.fontSize = "13px";
        bubble.style.lineHeight = "1.3";
        bubble.style.border = "1px solid rgba(0,0,0,0.08)";

        if (m.from === "bot") {
          bubble.style.alignSelf = "flex-start";
          bubble.style.background = "rgba(0,0,0,0.03)";
        } else {
          bubble.style.alignSelf = "flex-end";
          bubble.style.background = "rgba(0,120,255,0.10)";
        }

        messagesEl.appendChild(bubble);
      }
      scrollToBottom();
    }

    function renderOptions() {
      optionsEl.innerHTML = "";
      const node = decisionTree && decisionTree[currentNode];
      const options = node && Array.isArray(node.options) ? node.options : [];

      if (!options.length) return;

      for (const opt of options) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = opt.text || "Option";
        btn.style.padding = "8px 10px";
        btn.style.borderRadius = "10px";
        btn.style.border = "1px solid rgba(0,0,0,0.12)";
        btn.style.background = "white";
        btn.style.cursor = "pointer";
        btn.style.fontSize = "12px";
        btn.onclick = () => void handleOptionClick(opt);

        optionsEl.appendChild(btn);
      }
    }

    // ----------------------------
    // 5) Actions + option click
    // ----------------------------
    const actions = Object.assign(
      {
        // actions default (puedes meter más)
        noop() {},
      },
      widgetConfig.customActions || {},
    );

    async function handleOptionClick(option) {
      if (!decisionTree) return;

      addMessage(option.text, "user");

      // manda al backend lo que eligió
      void sendMessageToAPI(option.text, {
        type: "decision_option",
        currentNode,
        option,
      });

      // action
      if (option.action && actions[option.action]) {
        try {
          await Promise.resolve(
            actions[option.action]({ option, currentNode, decisionTree }),
          );
        } catch (e) {
          // si falla la acción, no mates el flujo
          console.warn("custom action failed:", e);
        }

        currentNode = "end";
        const endMsg = decisionTree["end"]?.message || "Listo.";
        addMessage(endMsg, "bot");

        void sendMessageToAPI(endMsg, { type: "bot_message", node: "end" });

        renderOptions();
        return;
      }

      // next
      if (option.next && decisionTree[option.next]) {
        currentNode = option.next;
        const botMsg = decisionTree[option.next]?.message || "";
        if (botMsg) addMessage(botMsg, "bot");

        void sendMessageToAPI(botMsg, {
          type: "bot_message",
          node: option.next,
        });

        renderOptions();
        return;
      }

      // si no hay next ni action
      renderOptions();
    }

    async function handleTextSend(text) {
      const clean = String(text || "").trim();
      if (!clean) return;

      addMessage(clean, "user");
      inputEl.value = "";

      // Envía al backend (para que responda y/o persista)
      await sendMessageToAPI(clean, {
        type: "free_text",
        currentNode,
      });

      // Si NO tienes backend que responda “bot”, puedes decidir aquí qué hacer:
      // - mantenerte en el mismo nodo
      // - o avanzar a un nodo fijo, etc.
    }

    sendBtn.onclick = () => void handleTextSend(inputEl.value);

    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void handleTextSend(inputEl.value);
    });

    // ----------------------------
    // 6) Open/Close behavior
    // ----------------------------
    async function openWidget() {
      isOpen = true;
      panel.style.display = "block";

      // prioridad: server history
      const loaded = await loadMessagesFromAPI();

      // fallback local (si server falla o no aplica)
      if (!loaded && history.length === 0) {
        if (decisionTree?.[currentNode]?.message)
          addMessage(decisionTree[currentNode].message, "bot");
      }

      renderMessages();
      renderOptions();
    }

    function closeWidget() {
      isOpen = false;
      panel.style.display = "none";
      saveState();
    }

    button.onclick = () => void (isOpen ? closeWidget() : openWidget());
    closeBtn.onclick = closeWidget;

    // ----------------------------
    // 7) Boot
    // ----------------------------
    async function boot() {
      loadConfigFromHTML();
      loadState();

      await loadTreeFromRemote();

      // si nodo inválido, resetea
      if (!decisionTree[currentNode]) currentNode = widgetConfig.initialNode;

      initializeDynamicTree();
    }

    void boot();
  }

  // auto-init
  initializeWidget();
})();
