const ATTENDANCE_SHEET_NAME = "MLAVS_Attendance";
const USERS_SHEET_NAME = "MLAVS_Users";

// Set this to the target spreadsheet ID when the Apps Script project is not bound
// to the spreadsheet that should store MLAVS data.
const SPREADSHEET_ID = "1PJx_EvlsuADuMl42mOUm4Kr4HzPMKmYL-HQjQIzhRp4";

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents || "{}");
    const action = payload.action || "log_event";

    if (action === "register_user") {
      return jsonResponse_(registerUser_(payload));
    }
    if (action === "upsert_user") {
      return jsonResponse_(upsertUser_(payload));
    }
    if (action === "get_user") {
      return jsonResponse_(getUser_(payload));
    }
    if (action === "log_event") {
      return jsonResponse_(logEvent_(payload));
    }

    return jsonResponse_({ ok: false, error: `Unsupported action: ${action}` });
  } catch (error) {
    console.error("MLAVS webhook failed", error);
    return jsonResponse_({ ok: false, error: String(error) });
  }
}

function getSpreadsheet_() {
  if (!SPREADSHEET_ID || SPREADSHEET_ID === "PASTE_YOUR_SPREADSHEET_ID_HERE") {
    throw new Error("Set SPREADSHEET_ID in code.gs to the spreadsheet that should store MLAVS data.");
  }
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}

function getDriveFolder_(folderId) {
  if (!folderId) {
    throw new Error("drive_folder_id is required.");
  }
  return DriveApp.getFolderById(folderId);
}

function registerUser_(payload) {
  const userPayload = payload.user || {};
  const userId = String(userPayload.user_id || "").trim();
  const email = String(userPayload.email || "").trim().toLowerCase();
  if (!userId) {
    throw new Error("user.user_id is required.");
  }
  if (!email) {
    throw new Error("user.email is required.");
  }

  const usersSheet = getOrCreateUsersSheet_();
  if (findUserRow_(usersSheet, userId)) {
    throw new Error("User ID already exists.");
  }
  if (findUserRowByEmail_(usersSheet, email)) {
    throw new Error("Email already registered.");
  }

  const nowIso = new Date().toISOString();
  usersSheet.appendRow([
    userId,
    userPayload.username || "",
    email,
    userPayload.full_name || userPayload.username || "",
    userPayload.active !== false,
    JSON.stringify(userPayload.metadata || {}),
    nowIso,
    nowIso,
    "",
    "",
    Number(userPayload.average_quality_score || 0),
    Number(userPayload.capture_count || 0),
    userPayload.password_hash || "",
    userPayload.password_salt || "",
  ]);

  return {
    ok: true,
    action: "register_user",
    user: {
      user_id: userId,
      username: userPayload.username || "",
      email: email,
      full_name: userPayload.full_name || userPayload.username || "",
      active: userPayload.active !== false,
      metadata: userPayload.metadata || {},
      created_at: nowIso,
      updated_at: nowIso,
      embeddings: [],
      average_quality_score: Number(userPayload.average_quality_score || 0),
      capture_count: Number(userPayload.capture_count || 0),
      embedding_file_id: "",
      embedding_file_url: "",
      password_hash: userPayload.password_hash || "",
      password_salt: userPayload.password_salt || "",
    },
  };
}

function upsertUser_(payload) {
  const userPayload = payload.user || {};
  const userId = String(userPayload.user_id || "").trim();
  if (!userId) {
    throw new Error("user.user_id is required.");
  }

  const usersSheet = getOrCreateUsersSheet_();
  const existingRow = findUserRow_(usersSheet, userId);
  if (!existingRow) {
    throw new Error("User not found. Register first.");
  }

  const embeddingFile = upsertEmbeddingFile_(payload.drive_folder_id, userPayload);
  const nowIso = new Date().toISOString();
  const existingCreatedAt = usersSheet.getRange(existingRow, 7).getValue();
  const existingUsername = usersSheet.getRange(existingRow, 2).getValue();
  const existingEmail = usersSheet.getRange(existingRow, 3).getValue();
  const existingPasswordHash = usersSheet.getRange(existingRow, 13).getValue();
  const existingPasswordSalt = usersSheet.getRange(existingRow, 14).getValue();

  const rowValues = [
    userId,
    userPayload.username || existingUsername || "",
    userPayload.email || existingEmail || "",
    userPayload.full_name || existingUsername || "",
    userPayload.active !== false,
    JSON.stringify(userPayload.metadata || {}),
    existingCreatedAt || nowIso,
    nowIso,
    embeddingFile.getId(),
    embeddingFile.getUrl(),
    Number(userPayload.average_quality_score || 0),
    Number(userPayload.capture_count || 0),
    userPayload.password_hash || existingPasswordHash || "",
    userPayload.password_salt || existingPasswordSalt || "",
  ];

  usersSheet.getRange(existingRow, 1, 1, rowValues.length).setValues([rowValues]);

  return {
    ok: true,
    action: "upsert_user",
    user: {
      user_id: userId,
      username: userPayload.username || existingUsername || "",
      email: userPayload.email || existingEmail || "",
      full_name: userPayload.full_name || existingUsername || "",
      active: userPayload.active !== false,
      average_quality_score: Number(userPayload.average_quality_score || 0),
      capture_count: Number(userPayload.capture_count || 0),
      metadata: userPayload.metadata || {},
      embeddings: userPayload.embeddings || [],
      created_at: normalizeDateValue_(existingCreatedAt || nowIso),
      updated_at: nowIso,
      embedding_file_id: embeddingFile.getId(),
      embedding_file_url: embeddingFile.getUrl(),
      password_hash: userPayload.password_hash || existingPasswordHash || "",
      password_salt: userPayload.password_salt || existingPasswordSalt || "",
    },
  };
}

function getUser_(payload) {
  const userId = String(payload.user_id || "").trim();
  if (!userId) {
    throw new Error("user_id is required.");
  }

  const usersSheet = getOrCreateUsersSheet_();
  const rowNumber = findUserRow_(usersSheet, userId);
  if (!rowNumber) {
    return { ok: true, action: "get_user", found: false };
  }

  const row = usersSheet.getRange(rowNumber, 1, 1, 14).getValues()[0];
  const embeddingFileId = row[8];
  const embeddingPayload = embeddingFileId ? JSON.parse(DriveApp.getFileById(embeddingFileId).getBlob().getDataAsString() || "{}") : {};
  const metadata = safeParseJson_(row[5]);

  return {
    ok: true,
    action: "get_user",
    found: true,
    user: {
      user_id: row[0],
      username: row[1],
      email: row[2],
      full_name: row[3],
      active: row[4] !== false,
      metadata: metadata || {},
      created_at: normalizeDateValue_(row[6]),
      updated_at: normalizeDateValue_(row[7]),
      embedding_file_id: row[8],
      embedding_file_url: row[9],
      average_quality_score: Number(row[10] || 0),
      capture_count: Number(row[11] || 0),
      password_hash: row[12] || "",
      password_salt: row[13] || "",
      embeddings: embeddingPayload.embeddings || [],
    },
  };
}

function logEvent_(payload) {
  const sheet = getOrCreateAttendanceSheet_();
  const auditFile = createAuditLog_(payload);
  const row = buildAttendanceRow_(payload, auditFile ? auditFile.getUrl() : "");
  sheet.appendRow(row);

  return {
    ok: true,
    action: "log_event",
    event_type: payload.event_type || "unknown",
    audit_url: auditFile ? auditFile.getUrl() : null,
  };
}

function getOrCreateAttendanceSheet_() {
  const spreadsheet = getSpreadsheet_();
  let sheet = spreadsheet.getSheetByName(ATTENDANCE_SHEET_NAME);

  if (!sheet) {
    sheet = spreadsheet.insertSheet(ATTENDANCE_SHEET_NAME);
    sheet.appendRow([
      "Timestamp",
      "Event Type",
      "User ID",
      "Session ID",
      "Meeting URL",
      "Meeting Title",
      "Status",
      "Final Score",
      "Identity Confidence",
      "Checkpoint Completed",
      "Checkpoint Total",
      "Visible Seconds",
      "Tracked Seconds",
      "Interactions",
      "Audit File URL",
      "Metadata JSON",
    ]);
    sheet.setFrozenRows(1);
  }

  return sheet;
}

function getOrCreateUsersSheet_() {
  const spreadsheet = getSpreadsheet_();
  let sheet = spreadsheet.getSheetByName(USERS_SHEET_NAME);

  if (!sheet) {
    sheet = spreadsheet.insertSheet(USERS_SHEET_NAME);
    sheet.appendRow([
      "User ID",
      "Username",
      "Email",
      "Full Name",
      "Active",
      "Metadata JSON",
      "Created At",
      "Updated At",
      "Embedding File ID",
      "Embedding File URL",
      "Average Quality Score",
      "Capture Count",
      "Password Hash",
      "Password Salt",
    ]);
    sheet.setFrozenRows(1);
  }

  return sheet;
}

function buildAttendanceRow_(payload, auditUrl) {
  const breakdown = payload.score_breakdown || {};
  return [
    payload.timestamp || new Date().toISOString(),
    payload.event_type || "",
    payload.user_id || "",
    payload.session_id || "",
    payload.meeting_url || "",
    payload.meeting_title || "",
    breakdown.status || payload.status || "",
    breakdown.final_score || payload.final_score || "",
    payload.identity_confidence || "",
    payload.checkpoint_completed || "",
    payload.checkpoint_total || "",
    payload.visible_seconds || "",
    payload.total_tracked_seconds || "",
    payload.interaction_count || "",
    auditUrl,
    JSON.stringify(payload),
  ];
}

function findUserRow_(sheet, userId) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return null;
  }

  const userIds = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (let index = 0; index < userIds.length; index += 1) {
    if (String(userIds[index][0]).trim() === userId) {
      return index + 2;
    }
  }
  return null;
}

function findUserRowByEmail_(sheet, email) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return null;
  }

  const emails = sheet.getRange(2, 3, lastRow - 1, 1).getValues();
  for (let index = 0; index < emails.length; index += 1) {
    if (String(emails[index][0]).trim().toLowerCase() === email) {
      return index + 2;
    }
  }
  return null;
}

function upsertEmbeddingFile_(folderId, userPayload) {
  const folder = getDriveFolder_(folderId);
  const safeUserId = String(userPayload.user_id || "user").replace(/[^a-zA-Z0-9_-]/g, "_");
  const filename = `mlavs_user_${safeUserId}_embeddings.json`;
  const content = JSON.stringify(
    {
      user_id: userPayload.user_id,
      username: userPayload.username || "",
      email: userPayload.email || "",
      full_name: userPayload.full_name || "",
      embeddings: userPayload.embeddings || [],
      metadata: userPayload.metadata || {},
      average_quality_score: Number(userPayload.average_quality_score || 0),
      capture_count: Number(userPayload.capture_count || 0),
      updated_at: new Date().toISOString(),
    },
    null,
    2
  );

  const files = folder.getFilesByName(filename);
  if (files.hasNext()) {
    const existingFile = files.next();
    existingFile.setContent(content);
    existingFile.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.VIEW);
    return existingFile;
  }

  const file = folder.createFile(filename, content, MimeType.PLAIN_TEXT);
  file.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.VIEW);
  return file;
}

function createAuditLog_(payload) {
  const folderId = payload.drive_folder_id;
  if (!folderId) {
    return null;
  }

  const folder = getDriveFolder_(folderId);
  const safeEventType = (payload.event_type || "event").replace(/[^a-zA-Z0-9_-]/g, "_");
  const safeSessionId = (payload.session_id || Utilities.getUuid()).replace(/[^a-zA-Z0-9_-]/g, "_");
  const filename = `mlavs_${safeEventType}_${safeSessionId}.json`;

  const file = folder.createFile(filename, JSON.stringify(payload, null, 2), MimeType.PLAIN_TEXT);
  file.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.VIEW);
  return file;
}

function normalizeDateValue_(value) {
  if (Object.prototype.toString.call(value) === "[object Date]") {
    return value.toISOString();
  }
  return String(value || "");
}

function safeParseJson_(value) {
  try {
    return JSON.parse(value || "{}");
  } catch (error) {
    return {};
  }
}

function jsonResponse_(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}
