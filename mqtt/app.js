const brokerUrl = "ws://localhost:9002"; // Menggunakan WS non-secure untuk sekarang
const secureBrokerUrl = "wss://localhost:9003"; // Secure WebSocket
let useSecureConnection = false; // Toggle untuk secure connection
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

const MESSAGE_EXPIRY_SETTINGS = {
  DOCUMENT_UPDATE: 5,    // 1 jam - untuk update dokumen
  EDIT_REQUEST: 60,         // 1 menit - untuk request edit access
  STATUS_MESSAGE: 300,      // 5 menit - untuk status messages
  CHAT_MESSAGE: 1800,       // 30 menit - untuk chat (jika ada)
  LAST_WILL: 300           // 5 menit - untuk Last Will (sudah ada)
};

const FLOW_CONTROL_SETTINGS = {
  MAX_CONCURRENT_PUBLISHES: 5,    // Maksimum 5 publish bersamaan
  MAX_QUEUE_SIZE: 50,              // Maksimum 50 message dalam queue
  PUBLISH_RATE_LIMIT: 100,         // Maksimum 100ms delay antar publish
  BACKPRESSURE_THRESHOLD: 10       // Trigger backpressure jika queue > 10
};

let messageQueue = [];
let activePublishes = 0;
let isBackpressureActive = false;
let lastPublishTime = 0;
let publishRateCounter = 0;

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

    // Use secure or standard URL based on toggle
    const currentBrokerUrl = useSecureConnection ? secureBrokerUrl : brokerUrl;
    const connectionType = useSecureConnection ? 'Secure (WSS)' : 'Standard (WS)';
    
    editorStatus.textContent = `Status: Connecting to ${connectionType} broker...`;
    console.log(`Attempting to connect to ${currentBrokerUrl} as ${connectUsername} using ${connectionType}`);

    // Last Will Message
    const lastWillMessage = JSON.stringify({
      user: connectUsername,
      clientId: clientId,
      action: "disconnected_unexpectedly",
      fileId: currentFileId || null,
      timestamp: new Date().toISOString(),
      message: `User ${connectUsername} disconnected unexpectedly`,
      connectionType: connectionType
    });

    const connectOptions = {
      clientId,
      protocolVersion: 5,
      username: connectUsername,
      password: connectPassword,
      clean: true,
      // TLS/SSL options untuk secure connection
      ...(useSecureConnection && {
        rejectUnauthorized: false, // Untuk development dengan self-signed cert
        // Untuk production, set ke true dan provide proper certificates
      }),
      // Last Will and Testament Configuration
      will: {
        topic: currentFileId ? `file/${currentFileId}/status` : `user/${connectUsername}/status`,
        payload: lastWillMessage,
        qos: 1,
        retain: false,
        properties: {
          willDelayInterval: 5,
          messageExpiryInterval: 300
        }
      }
    };

    if (client) {
        client.end(true);
        client = null;
    }

    client = mqtt.connect(currentBrokerUrl, connectOptions);

    client.once("connect", () => {
      const secureText = useSecureConnection ? ' (SSL/TLS Encrypted)' : '';
      editorStatus.textContent = `Status: Connected to ${connectionType} broker with Last Will configured`;
      console.log(`🔒 MQTT Connected as ${connectUsername} with Last Will Testament using ${connectionType}${secureText}`);
      userCredentials.username = connectUsername;
      userCredentials.password = connectPassword;
      isLoggedIn = true;
      updateLoginUI();
      setupClientEventListeners();
      resolve();
    });

    client.once("error", (err) => {
      editorStatus.textContent = `Status: MQTT error - ${err.message}. Check console.`;
      console.error(`MQTT Connection Error (${connectionType}):`, err);
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

// Update document.getElementById("btn-create").onclick - ganti bagian publish document
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

  // GANTI BAGIAN INI - pakai publishDocumentUpdate dengan expiry
  try {
    await publishDocumentUpdate(currentFileId, currentDocumentContent);
    console.log("✅ Initial document published with expiry");
  } catch (err) {
    console.error("❌ Failed to publish initial document:", err);
  }

  // TAMBAHKAN - Publish status message bahwa user joined
  try {
    await publishStatusMessage(
      `file/${currentFileId}/status`,
      {
        user: userCredentials.username,
        clientId: clientId,
        action: "joined",
        timestamp: new Date().toISOString(),
        message: `${userCredentials.username} created and joined the document`
      }
    );
    console.log("✅ Join status published with expiry");
  } catch (err) {
    console.error("❌ Failed to publish join status:", err);
  }

  editor.oninput = async () => {
    if (!hasEditAccess || !client || !client.connected) return;
    currentDocumentContent = editor.value;
    
    try {
      await publishDocumentUpdate(currentFileId, currentDocumentContent);
    } catch (err) {
      console.error("❌ Document update failed:", err);
    }
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

      // Publish join status dengan expiry
      try {
        await publishStatusMessage(
          `file/${currentFileId}/status`,
          {
            user: userCredentials.username,
            clientId: clientId,
            action: "joined",
            timestamp: new Date().toISOString(),
            message: `${userCredentials.username} joined the document`
          }
        );
      } catch (err) {
        console.error("❌ Failed to publish join status:", err);
      }

      editor.oninput = async () => {
        if (!hasEditAccess || !client || !client.connected) return;
        currentDocumentContent = editor.value;
        
        try {
          await publishDocumentUpdate(currentFileId, currentDocumentContent);
        } catch (err) {
          console.error("❌ Document update failed:", err);
        }
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

document.getElementById("btn-leave").onclick = async () => {
  if (client && client.connected && currentFileId) {
    unsubscribeAllTopics(currentFileId);
    
    // Publish leave message dengan expiry
    try {
      await publishStatusMessage(
        `file/${currentFileId}/status`,
        {
          user: userCredentials.username,
          clientId: clientId,
          action: "left",
          timestamp: new Date().toISOString(),
          message: `${userCredentials.username} left the document`
        },
        0 // QoS 0 untuk leave message (fire and forget)
      );
      console.log("✅ Leave status published with expiry");
    } catch (err) {
      console.warn("⚠️ Failed to publish leave status:", err);
    }
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

// Update function requestEditAccess
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

    // Request dengan message expiry
    publishWithExpiry(
      requestTopic,
      JSON.stringify({ 
        username: requestingUsername,
        timestamp: new Date().toISOString()
      }),
      {
        qos: 1,
        properties: {
          responseTopic: responseTopicForThisClient,
          correlationData: new TextEncoder().encode(correlationId),
        },
      },
      MESSAGE_EXPIRY_SETTINGS.EDIT_REQUEST
    ).then(() => {
      console.log("✅ Edit access request published with expiry");
    }).catch((err) => {
      clearTimeout(timeoutId);
      pendingRequests.delete(correlationId);
      console.error("❌ Failed to publish edit request:", err);
      reject(new Error(`Publish request failed: ${err.message}`));
    });
  });
}

document.addEventListener('DOMContentLoaded', () => {
    updateLoginUI();
    editorStatus.textContent = "Status: Ready. Enter credentials and Create/Join.";
});

function publishWithExpiry(topic, message, options = {}, expirySeconds = null) {
  const defaultExpiry = MESSAGE_EXPIRY_SETTINGS.STATUS_MESSAGE;
  const actualExpiry = expirySeconds || defaultExpiry;
  
  const publishOptions = {
    ...options,
    properties: {
      ...options.properties,
      messageExpiryInterval: actualExpiry // Message expires in seconds
    }
  };
  
  return new Promise((resolve, reject) => {
    client.publish(topic, message, publishOptions, (err) => {
      if (err) {
        console.error(`Publish to ${topic} with expiry ${actualExpiry}s failed:`, err);
        reject(err);
      } else {
        console.log(`✅ Published to ${topic} with ${actualExpiry}s expiry (QoS ${publishOptions.qos || 0})`);
        resolve();
      }
    });
  });
}

function publishDocumentUpdate(fileId, content) {
  return publishWithExpiry(
    `file/${fileId}/document/init`, 
    content, 
    {
      qos: 2,
      retain: true
    },
    MESSAGE_EXPIRY_SETTINGS.DOCUMENT_UPDATE
  );
}

// Update function: messages expiry
function publishStatusMessage(topic, statusData, qos = 1) {
  const message = typeof statusData === 'string' ? statusData : JSON.stringify(statusData);
  return publishWithExpiry(
    topic,
    message,
    { qos: qos },
    MESSAGE_EXPIRY_SETTINGS.STATUS_MESSAGE
  );
}

// Update toggle function untuk simulate SSL
function toggleSecureConnection() {
  useSecureConnection = !useSecureConnection;
  
  // Untuk demo purposes - tetap pakai port standard tapi simulate secure
  const connectionType = useSecureConnection ? 'Secure (SSL Simulation)' : 'Standard';
  const currentUrl = brokerUrl; // Tetap pakai port 9002
  
  editorStatus.textContent = `Status: Using ${connectionType} connection`;
  console.log(`🔒 ${useSecureConnection ? 'ENABLED' : 'DISABLED'} SSL Security Mode`);
  console.log(`Note: This is SSL simulation. Actual SSL requires Mosquitto with SSL support.`);
  console.log(`Connection URL: ${currentUrl}`);
  
  // Visual indicator
  updateSecurityIndicator();
  
  // Reconnect jika sudah connected
  if (client && client.connected) {
      console.log("Reconnecting with new security setting...");
      client.end(true, () => {
          connectAndSetupClient();
      });
  }
}

function updateSecurityIndicator() {
  // Update UI untuk show security status
  const statusElement = document.getElementById('security-status');
  if (statusElement) {
      statusElement.textContent = useSecureConnection ? '🔒 SECURE MODE' : '🔓 STANDARD MODE';
      statusElement.style.color = useSecureConnection ? '#4CAF50' : '#666';
      statusElement.style.fontWeight = 'bold';
  }
  
  // Log security status ke console
  if (useSecureConnection) {
      console.log(`🔒 Security Features Enabled:
      ✅ Connection Encryption (Simulated)
      ✅ Data Integrity Check (Simulated) 
      ✅ Certificate Validation (Simulated)
      ✅ Secure WebSocket Protocol (Simulated)`);
  } else {
      console.log(`🔓 Standard Mode: No encryption`);
  }
}

function publishWithFlowControl(topic, message, options = {}) {
  return new Promise((resolve, reject) => {
    // Check queue size limit
    if (messageQueue.length >= FLOW_CONTROL_SETTINGS.MAX_QUEUE_SIZE) {
      console.warn(`🚫 Flow Control: Queue full (${messageQueue.length}/${FLOW_CONTROL_SETTINGS.MAX_QUEUE_SIZE}), dropping message`);
      reject(new Error("Message queue full - flow control activated"));
      return;
    }
    
    // Add to queue
    messageQueue.push({ 
      topic, 
      message, 
      options, 
      resolve, 
      reject,
      timestamp: Date.now(),
      id: Math.random().toString(16).slice(2, 8)
    });
    
    console.log(`📬 Flow Control: Queued message for ${topic} (Queue: ${messageQueue.length}/${FLOW_CONTROL_SETTINGS.MAX_QUEUE_SIZE})`);
    
    // Check backpressure
    if (messageQueue.length > FLOW_CONTROL_SETTINGS.BACKPRESSURE_THRESHOLD && !isBackpressureActive) {
      activateBackpressure();
    }
    
    // Process queue
    processMessageQueue();
  });
}

function processMessageQueue() {
  // Check if we can publish more messages
  if (activePublishes >= FLOW_CONTROL_SETTINGS.MAX_CONCURRENT_PUBLISHES || messageQueue.length === 0) {
    return;
  }
  
  // Rate limiting - ensure minimum delay between publishes
  const now = Date.now();
  const timeSinceLastPublish = now - lastPublishTime;
  
  if (timeSinceLastPublish < FLOW_CONTROL_SETTINGS.PUBLISH_RATE_LIMIT) {
    // Schedule next attempt after rate limit delay
    setTimeout(() => processMessageQueue(), FLOW_CONTROL_SETTINGS.PUBLISH_RATE_LIMIT - timeSinceLastPublish);
    return;
  }
  
  // Get next message from queue (FIFO)
  const { topic, message, options, resolve, reject, timestamp, id } = messageQueue.shift();
  
  // Check message age (optional: drop old messages)
  const messageAge = now - timestamp;
  if (messageAge > 30000) { // Drop messages older than 30 seconds
    console.warn(`⏰ Flow Control: Dropping old message (age: ${messageAge}ms)`);
    reject(new Error("Message dropped - too old"));
    processMessageQueue(); // Continue with next message
    return;
  }
  
  activePublishes++;
  lastPublishTime = now;
  publishRateCounter++;
  
  console.log(`🚀 Flow Control: Publishing message ${id} to ${topic} (Active: ${activePublishes}/${FLOW_CONTROL_SETTINGS.MAX_CONCURRENT_PUBLISHES}, Queue: ${messageQueue.length})`);
  
  client.publish(topic, message, options, (err) => {
    activePublishes--;
    
    if (err) {
      console.error(`❌ Flow Control: Publish failed for ${topic}:`, err);
      reject(err);
    } else {
      console.log(`✅ Flow Control: Published to ${topic} (Remaining queue: ${messageQueue.length})`);
      resolve();
    }
    
    // Check if backpressure can be deactivated
    if (isBackpressureActive && messageQueue.length <= FLOW_CONTROL_SETTINGS.BACKPRESSURE_THRESHOLD / 2) {
      deactivateBackpressure();
    }
    
    // Process next message in queue
    setTimeout(() => processMessageQueue(), 10); // Small delay to prevent overwhelming
  });
}

function activateBackpressure() {
  isBackpressureActive = true;
  console.warn(`🔴 Flow Control: BACKPRESSURE ACTIVATED (Queue: ${messageQueue.length})`);
  
  // Show visual indicator
  showFlowControlNotification("⚠️ High message traffic - Flow control activated", "warning");
  
  // Update UI
  const statusElement = document.getElementById('flow-control-status');
  if (statusElement) {
    statusElement.textContent = '🔴 BACKPRESSURE';
    statusElement.style.color = 'red';
  }
}

function deactivateBackpressure() {
  isBackpressureActive = false;
  console.log(`🟢 Flow Control: Backpressure deactivated (Queue: ${messageQueue.length})`);
  
  // Show visual indicator
  showFlowControlNotification("✅ Message traffic normalized", "success");
  
  // Update UI
  const statusElement = document.getElementById('flow-control-status');
  if (statusElement) {
    statusElement.textContent = '🟢 NORMAL';
    statusElement.style.color = 'green';
  }
}

// Function untuk show flow control notifications
function showFlowControlNotification(message, className = "info") {
  const notification = document.createElement('div');
  notification.className = `flow-control-notification ${className}`;
  notification.textContent = message;
  notification.style.cssText = `
    position: fixed;
    top: 70px;
    right: 20px;
    padding: 8px 12px;
    border-radius: 5px;
    color: white;
    font-size: 12px;
    font-weight: bold;
    z-index: 1001;
    opacity: 0;
    transition: opacity 0.3s ease;
    max-width: 250px;
  `;
  
  // Set colors
  switch (className) {
    case "warning":
      notification.style.backgroundColor = "#ff9800";
      break;
    case "success":
      notification.style.backgroundColor = "#4caf50";
      break;
    default:
      notification.style.backgroundColor = "#2196f3";
  }
  
  document.body.appendChild(notification);
  
  // Fade in
  setTimeout(() => notification.style.opacity = "1", 100);
  
  // Fade out and remove
  setTimeout(() => {
    notification.style.opacity = "0";
    setTimeout(() => {
      if (notification.parentNode) {
        notification.parentNode.removeChild(notification);
      }
    }, 300);
  }, 3000);
}

// Update publish functions to use flow control
function publishDocumentUpdate(fileId, content) {
  return publishWithFlowControl(
    `file/${fileId}/document/init`, 
    content, 
    {
      qos: 2,
      retain: true,
      properties: {
        messageExpiryInterval: MESSAGE_EXPIRY_SETTINGS.DOCUMENT_UPDATE
      }
    }
  );
}

function publishStatusMessage(topic, statusData, qos = 1) {
  const message = typeof statusData === 'string' ? statusData : JSON.stringify(statusData);
  return publishWithFlowControl(
    topic,
    message,
    { 
      qos: qos,
      properties: {
        messageExpiryInterval: MESSAGE_EXPIRY_SETTINGS.STATUS_MESSAGE
      }
    }
  );
}

// Flow control statistics function
function getFlowControlStats() {
  return {
    queueLength: messageQueue.length,
    activePublishes: activePublishes,
    isBackpressureActive: isBackpressureActive,
    publishRateCounter: publishRateCounter,
    maxQueueSize: FLOW_CONTROL_SETTINGS.MAX_QUEUE_SIZE,
    maxConcurrentPublishes: FLOW_CONTROL_SETTINGS.MAX_CONCURRENT_PUBLISHES
  };
}

// Debug function untuk monitor flow control
function logFlowControlStats() {
  const stats = getFlowControlStats();
  console.log(`📊 Flow Control Stats:`, stats);
}

// Monitor flow control setiap 5 detik (untuk debug)
setInterval(logFlowControlStats, 5000);

// Function untuk test flow control
function testFlowControl() {
  if (!client || !client.connected) {
    alert("Please connect first!");
    return;
  }
  
  console.log("🧪 Testing Flow Control - Sending burst of messages...");
  
  // Send burst of 20 messages to test flow control
  for (let i = 0; i < 20; i++) {
    publishWithFlowControl(
      `test/flow-control`,
      `Test message ${i + 1}`,
      { qos: 1 }
    ).then(() => {
      console.log(`✅ Test message ${i + 1} sent`);
    }).catch(err => {
      console.warn(`⚠️ Test message ${i + 1} failed:`, err.message);
    });
  }
  
  // Update UI stats every second during test
  let testDuration = 10;
  const testInterval = setInterval(() => {
    updateFlowControlUI();
    testDuration--;
    if (testDuration <= 0) {
      clearInterval(testInterval);
    }
  }, 1000);
}

// Function untuk update flow control UI
function updateFlowControlUI() {
  const stats = getFlowControlStats();
  
  const queueLengthEl = document.getElementById('queue-length');
  const activePubEl = document.getElementById('active-publishes');
  
  if (queueLengthEl) queueLengthEl.textContent = stats.queueLength;
  if (activePubEl) activePubEl.textContent = stats.activePublishes;
}

// Update UI setiap 2 detik
setInterval(updateFlowControlUI, 2000);