const brokerUrl = "ws://localhost:9001"; // Mosquitto websocket port
const clientId = "client_" + Math.random().toString(16).slice(2, 8);

let client;
let username = "";
let currentFileId = null;
let isOwner = false;
let hasEditAccess = false;

const pendingRequests = new Map(); // correlationId => resolve

const userSection = document.getElementById("user-section");
const editorSection = document.getElementById("editor-section");
const editor = document.getElementById("editor");
const fileIdLabel = document.getElementById("file-id-label");
const editorStatus = document.getElementById("editor-status");
const joinMessage = document.getElementById("join-message");

// Modal elements
const modal = document.getElementById("modal");
const modalTitle = document.getElementById("modal-title");
const modalMessage = document.getElementById("modal-message");
const btnApprove = document.getElementById("btn-approve");
const btnDeny = document.getElementById("btn-deny");

// Helper
function genUUID() {
  return Math.random().toString(16).slice(2, 10);
}

let currentDocumentContent = ""; // simpan isi dokumen terakhir

function connectMQTT() {
  client = mqtt.connect(brokerUrl, {
    clientId,
    protocolVersion: 5,
  });

  client.on("connect", () => {
    editorStatus.textContent = "Status: Connected to broker";
    console.log("MQTT Connected");
  });

  client.on("error", (err) => {
    editorStatus.textContent = "Status: MQTT error";
    console.error(err);
  });

  client.on("message", (topic, message, packet) => {
    const msg = message.toString();

    if (!currentFileId) return;

    // Owner receives edit access requests
    if (isOwner && topic === `file/${currentFileId}/edit/request`) {
      const reqData = JSON.parse(msg);
      const requester = reqData.username;
      const responseTopic = packet.properties?.responseTopic;
      const correlationData = packet.properties?.correlationData;

      if (!responseTopic || !correlationData) {
        console.warn("Missing MQTT 5 properties in request");
        return;
      }

      showModal(requester, (approved) => {
        client.publish(
          responseTopic,
          approved ? "granted" : "denied",
          {
            qos: 1,
            properties: { correlationData },
          }
        );

        if (approved) {
          // Kirim isi dokumen terakhir ke user yang baru dapat akses
          client.publish(`file/${currentFileId}/document/init`, currentDocumentContent, { qos: 1 });
        }
      });
    }

    // User receives response to their edit access request
    if (!isOwner && topic === `file/${currentFileId}/edit/response`) {
      const correlationData = packet.properties?.correlationData;
      if (!correlationData) return;
      const corrStr = new TextDecoder().decode(correlationData);

      if (pendingRequests.has(corrStr)) {
        const resolve = pendingRequests.get(corrStr);
        resolve(msg);
        pendingRequests.delete(corrStr);
      }
    }

    // Document update for all with access
    if (topic === `file/${currentFileId}/document/update`) {
      if (!hasEditAccess) return;
      if (editor.value !== msg) {
        editor.value = msg;
        currentDocumentContent = msg; // update isi dokumen
      }
    }

    // Terima isi dokumen awal saat join (user baru yang di-approve)
    if (topic === `file/${currentFileId}/document/init`) {
      editor.value = msg;
      currentDocumentContent = msg;
    }
  });
}

// Show modal and get approval decision
function showModal(requester, callback) {
  modalTitle.textContent = "Edit Access Request";
  modalMessage.textContent = `User "${requester}" is requesting edit access. Approve?`;
  modal.classList.remove("hidden");

  function cleanup() {
    modal.classList.add("hidden");
    btnApprove.removeEventListener("click", onApprove);
    btnDeny.removeEventListener("click", onDeny);
  }

  function onApprove() {
    cleanup();
    callback(true);
  }

  function onDeny() {
    cleanup();
    callback(false);
  }

  btnApprove.addEventListener("click", onApprove);
  btnDeny.addEventListener("click", onDeny);
}

// UI event handlers

document.getElementById("btn-create").onclick = () => {
  username = document.getElementById("username").value.trim();
  if (!username) {
    alert("Please enter your username");
    return;
  }
  currentFileId = genUUID();
  isOwner = true;
  hasEditAccess = true;

  subscribeTopics(currentFileId);

  userSection.classList.add("hidden");
  editorSection.classList.remove("hidden");

  fileIdLabel.textContent = `File ID: ${currentFileId}`;

  editor.value = "";
  currentDocumentContent = "";
  editorStatus.textContent = "Status: You are the owner and have edit access";

  editor.oninput = () => {
    if (!hasEditAccess) return;
    currentDocumentContent = editor.value; // update konten terakhir
    client.publish(`file/${currentFileId}/document/update`, currentDocumentContent, { qos: 1 });
  };
};

document.getElementById("btn-join").onclick = async () => {
  username = document.getElementById("username").value.trim();
  if (!username) {
    alert("Please enter your username");
    return;
  }
  const joinFileId = document.getElementById("join-file-id").value.trim();
  if (!joinFileId) {
    alert("Please enter File ID to join");
    return;
  }

  currentFileId = joinFileId;
  isOwner = false;
  hasEditAccess = false;

  subscribeTopics(currentFileId);

  joinMessage.textContent = "Requesting edit access...";

  try {
    const allowed = await requestEditAccess(currentFileId, username);
    if (allowed === "granted") {
      hasEditAccess = true;
      joinMessage.textContent = "";
      userSection.classList.add("hidden");
      editorSection.classList.remove("hidden");

      fileIdLabel.textContent = `File ID: ${currentFileId}`;
      editorStatus.textContent = "Status: Edit access granted";

      // Editor sudah diisi otomatis dari topic document/init saat approve

      editor.oninput = () => {
        if (!hasEditAccess) return;
        currentDocumentContent = editor.value; // update konten terakhir
        client.publish(`file/${currentFileId}/document/update`, currentDocumentContent, { qos: 1 });
      };
    } else {
      joinMessage.textContent = "Edit access denied or no response.";
    }
  } catch (e) {
    joinMessage.textContent = "Error requesting edit access.";
  }
};

document.getElementById("btn-leave").onclick = () => {
  unsubscribeTopics(currentFileId);

  currentFileId = null;
  isOwner = false;
  hasEditAccess = false;

  editor.value = "";
  currentDocumentContent = "";
  userSection.classList.remove("hidden");
  editorSection.classList.add("hidden");
  joinMessage.textContent = "";
};

function subscribeTopics(fileId) {
  if (!client.connected) {
    client.on("connect", () => {
      client.subscribe(`file/${fileId}/edit/request`);
      client.subscribe(`file/${fileId}/edit/response`);
      client.subscribe(`file/${fileId}/document/update`);
      client.subscribe(`file/${fileId}/document/init`);
    });
  } else {
    client.subscribe(`file/${fileId}/edit/request`);
    client.subscribe(`file/${fileId}/edit/response`);
    client.subscribe(`file/${fileId}/document/update`);
    client.subscribe(`file/${fileId}/document/init`);
  }
}

function unsubscribeTopics(fileId) {
  client.unsubscribe(`file/${fileId}/edit/request`);
  client.unsubscribe(`file/${fileId}/edit/response`);
  client.unsubscribe(`file/${fileId}/document/update`);
  client.unsubscribe(`file/${fileId}/document/init`);
}

// Request edit access via MQTT 5 request-response
function requestEditAccess(fileId, username) {
  return new Promise((resolve, reject) => {
    const correlationId = genUUID();
    const requestTopic = `file/${fileId}/edit/request`;
    const responseTopic = `file/${fileId}/edit/response`;

    // Subscribe to response topic for this request
    client.subscribe(responseTopic);

    // Save resolve to map to handle async response
    pendingRequests.set(correlationId, (message) => {
      resolve(message);
      client.unsubscribe(responseTopic);
    });

    // Publish request with responseTopic and correlationData (correlationId)
    client.publish(
      requestTopic,
      JSON.stringify({ username }),
      {
        qos: 1,
        properties: {
          responseTopic,
          correlationData: new TextEncoder().encode(correlationId),
        },
      }
    );

    // Timeout fallback after 10 seconds
    setTimeout(() => {
      if (pendingRequests.has(correlationId)) {
        pendingRequests.delete(correlationId);
        client.unsubscribe(responseTopic);
        resolve("timeout");
      }
    }, 10000);
  });
}

connectMQTT();
