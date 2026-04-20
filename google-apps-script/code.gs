const SHEET_NAME = "MLAVS_Attendance";

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents || "{}");
    const sheet = getOrCreateSheet_();
    const auditFile = createAuditLog_(payload);
    const row = buildRow_(payload, auditFile ? auditFile.getUrl() : "");

    sheet.appendRow(row);

    return jsonResponse_({
      ok: true,
      event_type: payload.event_type || "unknown",
      audit_url: auditFile ? auditFile.getUrl() : null,
    });
  } catch (error) {
    console.error("MLAVS webhook failed", error);
    return jsonResponse_({
      ok: false,
      error: String(error),
    });
  }
}

function getOrCreateSheet_() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = spreadsheet.getSheetByName(SHEET_NAME);

  if (!sheet) {
    sheet = spreadsheet.insertSheet(SHEET_NAME);
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

function buildRow_(payload, auditUrl) {
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

function createAuditLog_(payload) {
  const folderId = payload.drive_folder_id;
  if (!folderId) {
    return null;
  }

  const folder = DriveApp.getFolderById(folderId);
  const safeEventType = (payload.event_type || "event").replace(/[^a-zA-Z0-9_-]/g, "_");
  const safeSessionId = (payload.session_id || Utilities.getUuid()).replace(/[^a-zA-Z0-9_-]/g, "_");
  const filename = `mlavs_${safeEventType}_${safeSessionId}.json`;

  const file = folder.createFile(filename, JSON.stringify(payload, null, 2), MimeType.PLAIN_TEXT);
  file.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.VIEW);
  return file;
}

function jsonResponse_(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}
