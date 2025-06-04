const brokerUrl = "ws://localhost:9002"; // Menggunakan WS non-secure untuk sekarang
const clientId = "client_" + Math.random().toString(16).slice(2, 8);

let client;
let userCredentials = { username: "", password: "" };
let isLoggedIn = false;
let currentFileId = null;
let isOwner = false;
let hasEditAccess = false;

const pendingRequests = new Map();

const userSection = document.getElementById("user-section");
const editorSection = document.getElementById("editor-section");
const editor = document.getElementById("editor");
const fileIdLabel = document.getElementById("file-id-label");
const editorStatus = document.getElementById("editor-status");
const joinMessage = document.getElementById("join-message");
const credentialsInputSection = document.getElementById("credentials-input-section");
const loggedInInfoSection = document.getElementById("logged-in-info-section");
const loggedInUsernameSpan = document.getElementById("logged-in-username");
const btnLogout = document.getElementById("btn-logout");
const usernameInput = document.getElementById("username");
const passwordInput = document.getElementById("password");
const modal = document.getElementById("modal");
const modalTitle = document.getElementById("modal-title");
const modalMessage = document.getElementById("modal-message");
let btnApprove = document.getElementById("btn-approve");
let btnDeny = document.getElementById("btn-deny");


function genUUID() {
  return Math.random().toString(16).slice(2, 10);
}

let currentDocumentContent = "";

function updateLoginUI() {
  if (isLoggedIn && userCredentials.username) {
    credentialsInputSection.classList.add("hidden");
    loggedInUsernameSpan.textContent = userCredentials.username;
    loggedInInfoSection.classList.remove("hidden");
  } else {
    credentialsInputSection.classList.remove("hidden");
    loggedInInfoSection.classList.add("hidden");
    usernameInput.value = "";
    passwordInput.value = "";
    userCredentials.username = "";
    userCredentials.password = "";
  }
}

btnLogout.onclick = () => {
  if (client && client.connected) {
    if (currentFileId) {
      document.getElementById("btn-leave").click();
    }
    client.end(true, () => {
      console.log("Logged out and disconnected from MQTT.");
      client = null;
      isLoggedIn = false;
      updateLoginUI();
      editorStatus.textContent = "Status: Logged out. Ready to connect.";
    });
  } else {
    isLoggedIn = false;
    updateLoginUI();
    editorStatus.textContent = "Status: Logged out. Ready to connect.";
  }
};

function connectAndSetupClient() {
  return new Promise((resolve, reject) => {
    if (client && client.connected && isLoggedIn) {
      console.log("Already connected with stored credentials.");
      resolve();
      return;
    }

    let connectUsername, connectPassword;
    if (!isLoggedIn) {
      connectUsername = usernameInput.value.trim();
      connectPassword = passwordInput.value.trim();
      if (!connectUsername || !connectPassword) {
        alert("Username and Password are required for initial login.");
        reject(new Error("Username and Password are required."));
        return;
      }
    } else {
      connectUsername = userCredentials.username;
      connectPassword = userCredentials.password;
    }

    editorStatus.textContent = "Status: Connecting to broker...";
    console.log(`Attempting to connect to ${brokerUrl} as ${connectUsername}`);

    // Last Will Message - akan dipublish otomatis jika client disconnect tidak normal
    const lastWillMessage = JSON.stringify({
      user: connectUsername,
      clientId: clientId,
      action: "disconnected_unexpectedly",
      fileId: currentFileId || null,
      timestamp: new Date().toISOString(),
      message: `User ${connectUsername} disconnected unexpectedly`
    });

    const connectOptions = {
      clientId,
      protocolVersion: 5,
      username: connectUsername,
      password: connectPassword,
      clean: true,
      // Last Will and Testament Configuration
      will: {
        topic: currentFileId ? `file/${currentFileId}/status` : `user/${connectUsername}/status`,
        payload: lastWillMessage,
        qos: 1, // QoS 1 untuk memastikan Last Will terkirim
        retain: false, // Tidak retain Last Will message
        properties: {
          willDelayInterval: 5, // Delay 5 detik sebelum publish Last Will
          messageExpiryInterval: 300 // Last Will message expire dalam 5 menit
        }
      }
    };

    if (client) {
        client.end(true);
        client = null;
    }

    client = mqtt.connect(brokerUrl, connectOptions);

    client.once("connect", () => {
      editorStatus.textContent = "Status: Connected to broker with Last Will configured";
      console.log("MQTT Connected as", connectUsername, "with Last Will Testament");
      userCredentials.username = connectUsername;
      userCredentials.password = connectPassword;
      isLoggedIn = true;
      updateLoginUI();
      setupClientEventListeners();
      resolve();
    });

    client.once("error", (err) => {
      editorStatus.textContent = `Status: MQTT error - ${err.message}. Check console.`;
      console.error("MQTT Connection Error:", err);
      joinMessage.textContent = `Connection failed: ${err.message}. Check credentials or broker.`;
      if (!isLoggedIn) {
        userCredentials.username = "";
        userCredentials.password = "";
      }
      if (client) client.end(true);
      client = null;
      reject(err);
    });
  });
}

function setupClientEventListeners() {
  if (!client) return;

  client.removeAllListeners('message');
  client.removeAllListeners('reconnect');
  client.removeAllListeners('close');

  client.on("message", (topic, message, packet) => {
      const msg = message.toString();
      console.log(`Message on ${topic} (QoS ${packet.qos}): ${msg.length > 50 ? msg.substring(0,50)+'...' : msg}`);

      if (!currentFileId) return;

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
                  { qos: 1, properties: { correlationData } }
              );
          });
      } else if (topic.startsWith(`client/${clientId}/file/${currentFileId}/edit/response`)) {
          const correlationData = packet.properties?.correlationData;
          if (!correlationData) return;
          const corrStr = new TextDecoder().decode(correlationData);

          if (pendingRequests.has(corrStr)) {
              const { resolve } = pendingRequests.get(corrStr);
              resolve(msg);
              pendingRequests.delete(corrStr);
          }
      } else if (topic === `file/${currentFileId}/document/init`) {
          if (editor.value !== msg) {
              editor.value = msg;
              currentDocumentContent = msg;
              console.log("Initial/Updated document content set from init topic:", msg.substring(0,50)+'...');
          }
      } 
      // TAMBAHAN: Handle Last Will and status messages
      else if (topic === `file/${currentFileId}/status` || topic.startsWith('user/')) {
          try {
              const statusData = JSON.parse(msg);
              handleUserStatusMessage(statusData);
          } catch (e) {
              // Jika bukan JSON, treat sebagai simple status message
              console.log(`Status message: ${msg}`);
              showStatusNotification(msg);
          }
      }
  });

  client.on("reconnect", () => {
      editorStatus.textContent = "Status: Reconnecting...";
      console.log("MQTT Reconnecting");
  });

  client.on("close", () => {
      editorStatus.textContent = "Status: Connection closed.";
      console.log("MQTT Connection Closed");
  });
}

// TAMBAHAN: Function untuk handle status messages (termasuk Last Will)
function handleUserStatusMessage(statusData) {
  const { user, action, timestamp, message, clientId: senderClientId } = statusData;
  
  // Jangan process message dari diri sendiri
  if (senderClientId === clientId) return;
  
  console.log(`User Status Update:`, statusData);
  
  let notificationMessage = "";
  let notificationClass = "";
  
  switch (action) {
      case "disconnected_unexpectedly":
          notificationMessage = `⚠️ ${user} disconnected unexpectedly`;
          notificationClass = "warning";
          break;
      case "left":
          notificationMessage = `👋 ${user} left the document`;
          notificationClass = "info";
          break;
      case "joined":
          notificationMessage = `👤 ${user} joined the document`;
          notificationClass = "success";
          break;
      default:
          notificationMessage = message || `${user}: ${action}`;
          notificationClass = "info";
  }
  
  showStatusNotification(notificationMessage, notificationClass);
}

// TAMBAHAN: Function untuk show notifications
function showStatusNotification(message, className = "info") {
  // Buat element notification
  const notification = document.createElement('div');
  notification.className = `notification ${className}`;
  notification.textContent = message;
  notification.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      padding: 10px 15px;
      border-radius: 5px;
      color: white;
      font-weight: bold;
      z-index: 1000;
      opacity: 0;
      transition: opacity 0.3s ease;
  `;
  
  // Set colors based on class
  switch (className) {
      case "warning":
          notification.style.backgroundColor = "#ff9800";
          break;
      case "success":
          notification.style.backgroundColor = "#4caf50";
          break;
      case "error":
          notification.style.backgroundColor = "#f44336";
          break;
      default:
          notification.style.backgroundColor = "#2196f3";
  }
  
  document.body.appendChild(notification);
  
  // Fade in
  setTimeout(() => notification.style.opacity = "1", 100);
  
  // Fade out and remove after 5 seconds
  setTimeout(() => {
      notification.style.opacity = "0";
      setTimeout(() => {
          if (notification.parentNode) {
              notification.parentNode.removeChild(notification);
          }
      }, 300);
  }, 5000);
}

function showModal(requester, callback) {
  modalTitle.textContent = "Edit Access Request";
  modalMessage.textContent = `User "${requester}" is requesting edit access. Approve?`;
  modal.classList.remove("hidden");

  const newBtnApprove = btnApprove.cloneNode(true);
  btnApprove.parentNode.replaceChild(newBtnApprove, btnApprove);
  btnApprove = newBtnApprove;
  const newBtnDeny = btnDeny.cloneNode(true);
  btnDeny.parentNode.replaceChild(newBtnDeny, btnDeny);
  btnDeny = newBtnDeny;

  function cleanup() { modal.classList.add("hidden"); }
  btnApprove.addEventListener("click", () => { cleanup(); callback(true); }, { once: true });
  btnDeny.addEventListener("click", () => { cleanup(); callback(false); }, { once: true });
}

document.getElementById("btn-create").onclick = async () => {
  try {
    await connectAndSetupClient();
  } catch (error) { return; }

  currentFileId = genUUID();
  isOwner = true;
  hasEditAccess = true;

  userSection.classList.add("hidden");
  editorSection.classList.remove("hidden");
  joinMessage.textContent = "";
  fileIdLabel.textContent = `File ID: ${currentFileId}`;
  editor.value = "";
  currentDocumentContent = "";
  editorStatus.textContent = `Status: You are owner. File ID: ${currentFileId}`;

  subscribeAllTopics(currentFileId);

  // Publikasikan pesan inisialisasi dokumen dengan QoS 2 dan RETAIN
  client.publish(`file/${currentFileId}/document/init`, currentDocumentContent, {
    qos: 2, // <<<< QoS 2 untuk dokumen
    retain: true,
  }, (err) => {
    if(err) console.error("Publish retain init (QoS 2) error:", err);
    else console.log(`Published initial document to file/${currentFileId}/document/init with QoS 2, retain=true.`);
  });

  editor.oninput = () => {
    if (!hasEditAccess || !client || !client.connected) return;
    currentDocumentContent = editor.value;
    // Perubahan dokumen juga dengan QoS 2
    client.publish(`file/${currentFileId}/document/init`, currentDocumentContent, {
        qos: 2, // <<<< QoS 2 untuk update dokumen
        retain: true
    }, (err) => {
        if(err) console.error(`Publish document update (QoS 2) for ${currentFileId} error:`, err);
        // else console.log(`Published document update (QoS 2) for ${currentFileId}`); // Bisa terlalu verbose
    });
  };
};

document.getElementById("btn-join").onclick = async () => {
  const joinFileId = document.getElementById("join-file-id").value.trim();
  if (!joinFileId) {
    alert("Please enter File ID to join");
    return;
  }

  try {
    await connectAndSetupClient();
  } catch (error) { return; }

  currentFileId = joinFileId;
  isOwner = false;
  hasEditAccess = false;
  joinMessage.textContent = "Requesting edit access...";
  editorStatus.textContent = "Status: Attempting to join file...";

  subscribeAllTopics(currentFileId);

  try {
    const allowed = await requestEditAccess(currentFileId, userCredentials.username);
    if (allowed === "granted") {
      hasEditAccess = true;
      joinMessage.textContent = "";
      userSection.classList.add("hidden");
      editorSection.classList.remove("hidden");
      fileIdLabel.textContent = `File ID: ${currentFileId}`;
      editorStatus.textContent = "Status: Edit access granted. Document should load.";

      editor.oninput = () => {
        if (!hasEditAccess || !client || !client.connected) return;
        currentDocumentContent = editor.value;
        // Update dokumen oleh pengguna yang join juga QoS 2
        client.publish(`file/${currentFileId}/document/init`, currentDocumentContent, {
            qos: 2, // <<<< QoS 2 untuk update dokumen
            retain: true
        }, (err) => {
            if(err) console.error(`Publish document update (QoS 2) for ${currentFileId} error:`, err);
        });
      };
    } else if (allowed === "timeout") {
      joinMessage.textContent = "Edit access request timed out.";
      editorStatus.textContent = "Status: Join failed (timeout).";
      cleanupAfterFailedJoin();
    } else {
      joinMessage.textContent = "Edit access denied or file not found.";
      editorStatus.textContent = "Status: Join failed (denied/not found).";
      cleanupAfterFailedJoin();
    }
  } catch (e) {
    joinMessage.textContent = `Error requesting access: ${e.message}`;
    editorStatus.textContent = "Status: Join failed (error).";
    console.error("Error requesting edit access:", e);
    cleanupAfterFailedJoin();
  }
};

function cleanupAfterFailedJoin() {
    if (client && currentFileId) {
        unsubscribeAllTopics(currentFileId);
    }
    currentFileId = null;
}

document.getElementById("btn-leave").onclick = () => {
  if (client && client.connected && currentFileId) {
    unsubscribeAllTopics(currentFileId);
    // Contoh pesan 'user left' dengan QoS 0 (fire and forget)
    // Ini opsional dan hanya contoh penggunaan QoS 0
    const leaveMessage = JSON.stringify({ user: userCredentials.username, action: "left" });
    client.publish(`file/${currentFileId}/status`, leaveMessage, { qos: 0 }, (err) => {
        if(err) console.warn("Publish leave status (QoS 0) error:", err);
        else console.log(`Published leave status (QoS 0) for ${currentFileId}`);
    });
  }

  currentFileId = null;
  isOwner = false;
  hasEditAccess = false;
  editor.value = "";
  currentDocumentContent = "";
  userSection.classList.remove("hidden");
  editorSection.classList.add("hidden");
  joinMessage.textContent = "";
  editorStatus.textContent = "Status: Left file. Ready.";
};

function subscribeAllTopics(fileId) {
  if (!client || !client.connected) {
    console.warn("Cannot subscribe, MQTT client not connected.");
    return;
  }
  
  const topics = {
    [`file/${fileId}/edit/request`]: { qos: 1 },
    [`client/${clientId}/file/${fileId}/edit/response`]: { qos: 1 },
    [`file/${fileId}/document/init`]: { qos: 2 },
    [`file/${fileId}/status`]: { qos: 1 }, // Subscribe ke status messages untuk Last Will
    [`user/+/status`]: { qos: 1 } // Subscribe ke user status messages (wildcard)
  };

  client.subscribe(topics, (err, granted) => {
    if (err) {
      console.error("Subscription error:", err);
      editorStatus.textContent = "Status: Subscription error.";
      return;
    }
    granted.forEach(g => console.log(`Subscribed to ${g.topic} with QoS ${g.qos}`));
  });
}

function unsubscribeAllTopics(fileId) {
  if (!client || !client.connected) {
    console.warn("Cannot unsubscribe, MQTT client not connected.");
    return;
  }
  const topicsToUnsubscribe = [
    `file/${fileId}/edit/request`,
    `client/${clientId}/file/${fileId}/edit/response`,
    `file/${fileId}/document/init`,
    `file/${fileId}/status`,
    `user/+/status`
  ];
  client.unsubscribe(topicsToUnsubscribe, (err) => {
    if (err) console.error("Unsubscription error:", err);
    else console.log("Unsubscribed from topics for fileId:", fileId);
  });
}

function requestEditAccess(fileId, requestingUsername) {
  return new Promise((resolve, reject) => {
    if (!client || !client.connected) {
      reject(new Error("MQTT client not connected."));
      return;
    }

    const correlationId = genUUID();
    const requestTopic = `file/${fileId}/edit/request`;
    const responseTopicForThisClient = `client/${clientId}/file/${fileId}/edit/response`;

    const timeoutId = setTimeout(() => {
      if (pendingRequests.has(correlationId)) {
        const { reject: promiseReject } = pendingRequests.get(correlationId);
        pendingRequests.delete(correlationId);
        promiseReject(new Error("timeout"));
      }
    }, 15000);

    pendingRequests.set(correlationId, { resolve, reject, timeoutId });

    // Permintaan akses edit dengan QoS 1
    client.publish(
      requestTopic,
      JSON.stringify({ username: requestingUsername }),
      {
        qos: 1, // <<<< QoS 1 untuk permintaan akses
        properties: {
          responseTopic: responseTopicForThisClient,
          correlationData: new TextEncoder().encode(correlationId),
        },
      },
      (err) => {
          if (err) {
              clearTimeout(timeoutId);
              pendingRequests.delete(correlationId);
              console.error("Failed to publish edit request (QoS 1):", err);
              reject(new Error(`Publish request failed: ${err.message}`));
          } else {
              console.log("Edit access request (QoS 1) published.");
          }
      }
    );
  });
}

document.addEventListener('DOMContentLoaded', () => {
    updateLoginUI();
    editorStatus.textContent = "Status: Ready. Enter credentials and Create/Join.";
});