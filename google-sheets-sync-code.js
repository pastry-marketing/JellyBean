/**
 * =========================================================================
 * JELLYBEAN CRM -> GOOGLE SHEETS LIVE SYNC SCRIPT
 * Target Spreadsheet: https://docs.google.com/spreadsheets/d/1JOW5XGEsDa-ewm7Xh4BIzru8_QU_z4MFFXTZ9ZvZodE/edit
 * =========================================================================
 * 
 * EXACT COLUMNS STRUCTURE (13 Columns):
 * 1.  Lead Created Date & Time (Column A - VERY FIRST)
 * 2.  Customer Name            (Column B)
 * 3.  Customer Phone No        (Column C)
 * 4.  Area                     (Column D)
 * 5.  Service                  (Column E)
 * 6.  Status                   (Column F)
 * 7.  Number Name              (Column G)
 * 8.  Context                  (Column H)
 * 9.  Exact Customer Requirement (Column I)
 * 10. Compose                  (Column J)
 * 11. Assigned To              (Column K - THIRD LAST COLUMN)
 * 12. Important                (Column L - SECOND LAST COLUMN)
 * 13. Lead ID                  (Column M - LAST COLUMN / Hidden / Tracking)
 * 
 * SHEETS:
 * 1. "New to Contact"  -> ONLY leads with status "New to contact" WITHOUT Pinned Important
 * 2. "Pinned Important"-> ONLY leads with status "New to contact" WITH Pinned Important
 */

const CONFIG = {
  SHEET_NEW_TO_CONTACT: "New to Contact",
  SHEET_PINNED_IMPORTANT: "Pinned Important",
  
  HEADERS: [
    "Lead Created Date & Time",  // 1 (Column A - Very First)
    "Customer Name",             // 2 (Column B)
    "Customer Phone No",         // 3 (Column C)
    "Area",                      // 4 (Column D)
    "Service",                   // 5 (Column E)
    "Status",                    // 6 (Column F)
    "Number Name",               // 7 (Column G)
    "Context",                   // 8 (Column H)
    "Exact Customer Requirement",// 9 (Column I)
    "Compose",                   // 10 (Column J)
    "Assigned To",               // 11 (Column K - Third Last Column)
    "Important",                 // 12 (Column L - Second Last Column)
    "Lead ID"                    // 13 (Column M - Last Column)
  ]
};

/**
 * Creates custom CRM menu in Google Sheets
 */
function onOpen() {
  SpreadsheetApp.getUi().createMenu("⚡ Jellybean CRM")
    .addItem("Format & Setup Sheets", "setupSheets")
    .addItem("Check Webhook Status", "checkWebhookStatus")
    .addToUi();
}

/**
 * Test alert to verify Apps Script is functioning
 */
function checkWebhookStatus() {
  SpreadsheetApp.getUi().alert("Jellybean CRM Sync Script is active and ready for live sync.");
}

/**
 * Creates and formats the two required sheets:
 * 1. "New to Contact"
 * 2. "Pinned Important"
 */
function setupSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const targetSheets = [CONFIG.SHEET_NEW_TO_CONTACT, CONFIG.SHEET_PINNED_IMPORTANT];

  targetSheets.forEach((name, idx) => {
    let sheet = ss.getSheetByName(name);
    if (!sheet) {
      sheet = ss.insertSheet(name, idx);
    }
    
    // Set headers
    sheet.getRange(1, 1, 1, CONFIG.HEADERS.length).setValues([CONFIG.HEADERS]);
    
    // Style headers
    const headerRange = sheet.getRange(1, 1, 1, CONFIG.HEADERS.length);
    headerRange.setFontWeight("bold");
    headerRange.setFontSize(10);
    headerRange.setBackground(name === CONFIG.SHEET_PINNED_IMPORTANT ? "#fee2e2" : "#e0e7ff");
    headerRange.setFontColor("#0f172a");
    headerRange.setVerticalAlignment("middle");
    sheet.setRowHeight(1, 38);
    sheet.setFrozenRows(1);
    
    // Column widths tailored for readable CRM content
    sheet.setColumnWidth(1, 180); // Lead Created Date & Time (Column A)
    sheet.setColumnWidth(2, 180); // Customer Name
    sheet.setColumnWidth(3, 160); // Customer Phone No
    sheet.setColumnWidth(4, 140); // Area
    sheet.setColumnWidth(5, 130); // Service
    sheet.setColumnWidth(6, 130); // Status
    sheet.setColumnWidth(7, 140); // Number Name
    sheet.setColumnWidth(8, 220); // Context
    sheet.setColumnWidth(9, 240); // Exact Customer Requirement
    sheet.setColumnWidth(10, 220); // Compose
    sheet.setColumnWidth(11, 160); // Assigned To (Third last column)
    sheet.setColumnWidth(12, 130); // Important (Second last column)
    sheet.setColumnWidth(13, 120); // Lead ID (Last column)
  });

  // Remove default blank "Sheet1" if target sheets exist
  const defaultSheet = ss.getSheetByName("Sheet1");
  if (defaultSheet && ss.getSheets().length > 1) {
    try { ss.deleteSheet(defaultSheet); } catch (e) {}
  }

  SpreadsheetApp.getActiveSpreadsheet().toast("Sheets formatted! 13 columns configured successfully.", "Jellybean CRM");
}

/**
 * Transforms a CRM Lead object into 13 columns array matching exact requirements
 */
function leadToRow(lead) {
  // 1. Created Date & Time (Column A)
  let createdDate = lead.created_at || lead.assigned_at || "";
  if (createdDate) {
    try {
      const d = new Date(createdDate);
      if (!isNaN(d.getTime())) {
        createdDate = Utilities.formatDate(d, Session.getScriptTimeZone() || "GMT+5", "yyyy-MM-dd HH:mm:ss");
      }
    } catch (e) {}
  }

  // 3. Customer Phone No (Combine main + secondary if available)
  const phone = lead.customer_number_2 
    ? `${lead.customer_number || ''}, ${lead.customer_number_2}` 
    : (lead.customer_number || '');
    
  // 4. Area
  const area = lead.main_area || lead.sub_area || lead.area || "";

  // 6. Status
  const status = lead.cs_status === "new" ? "New to contact" : (lead.cs_status || "New to contact");

  // 9. Exact Customer Requirement
  const exactRequirement = lead.requirement_1 || lead.requirement_2 || lead.post_text || lead.exact_requirement || lead.context || "";
  
  // 10. Compose
  const compose = lead.marketing_notes || lead.compose || "";

  // 11. Assigned To (Third Last Column - Resolved Staff Name)
  const assignedName = lead.assigned_to_name || (lead.assigned_to && !lead.assigned_to.includes("-") ? lead.assigned_to : "Unassigned");

  // 12. Important (Second Last Column)
  let importantStatus = "No";
  if (lead.pinned_important === true) {
    importantStatus = "Pinned Important";
  } else if (lead.is_important === true) {
    importantStatus = "Important";
  }

  return [
    createdDate,                  // 1. Lead Created Date & Time (Column A)
    lead.customer_name || "",     // 2. Customer Name
    phone,                        // 3. Customer Phone No
    area,                         // 4. Area
    lead.service || lead.pass_it_to || "", // 5. Service
    status,                       // 6. Status
    lead.number_name || "",       // 7. Number Name
    lead.context || "",           // 8. Context
    exactRequirement,             // 9. Exact Customer Requirement
    compose,                      // 10. Compose
    assignedName,                 // 11. Assigned To (THIRD LAST COLUMN)
    importantStatus,              // 12. Important (SECOND LAST COLUMN)
    lead.id || ""                 // 13. Lead ID (LAST COLUMN)
  ];
}

/**
 * Handles GET requests (for browser test)
 */
function doGet(e) {
  return ContentService.createTextOutput(JSON.stringify({
    status: "active",
    message: "Jellybean CRM Google Sheets Sync Engine is live!",
    time: new Date().toISOString()
  })).setMimeType(ContentService.MimeType.JSON);
}

/**
 * Main Webhook Receiver: Handles POST requests from Jellybean CRM
 * Supports: PING, BULK_SYNC, INSERT, UPDATE, DELETE
 */
function doPost(e) {
  try {
    let payload = {};
    if (e && e.postData && e.postData.contents) {
      payload = JSON.parse(e.postData.contents);
    } else if (e && e.parameter) {
      payload = e.parameter;
    }

    const eventType = (payload.type || payload.action || "").toUpperCase();
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheetNew = ss.getSheetByName(CONFIG.SHEET_NEW_TO_CONTACT) || ss.insertSheet(CONFIG.SHEET_NEW_TO_CONTACT);
    const sheetPinned = ss.getSheetByName(CONFIG.SHEET_PINNED_IMPORTANT) || ss.insertSheet(CONFIG.SHEET_PINNED_IMPORTANT);

    // ── 1. TEST PING ──
    if (eventType === "PING") {
      return jsonResponse({
        status: "ok",
        message: "Connected to Google Sheets successfully! Ready for live sync.",
        spreadsheet: ss.getName()
      });
    }

    // ── 2. BULK SYNC ──
    if (eventType === "BULK_SYNC") {
      setupSheets();
      const leads = payload.leads || [];

      if (sheetNew.getLastRow() > 1) {
        sheetNew.getRange(2, 1, sheetNew.getLastRow() - 1, CONFIG.HEADERS.length).clearContent();
      }
      if (sheetPinned.getLastRow() > 1) {
        sheetPinned.getRange(2, 1, sheetPinned.getLastRow() - 1, CONFIG.HEADERS.length).clearContent();
      }

      const unpinnedNewRows = [];
      const pinnedRows = [];

      leads.forEach(l => {
        const row = leadToRow(l);
        if (l.pinned_important === true) {
          pinnedRows.push(row);
        } else {
          unpinnedNewRows.push(row);
        }
      });

      if (unpinnedNewRows.length > 0) {
        sheetNew.getRange(2, 1, unpinnedNewRows.length, CONFIG.HEADERS.length).setValues(unpinnedNewRows);
      }
      if (pinnedRows.length > 0) {
        sheetPinned.getRange(2, 1, pinnedRows.length, CONFIG.HEADERS.length).setValues(pinnedRows);
      }

      return jsonResponse({
        status: "success",
        unpinnedCount: unpinnedNewRows.length,
        pinnedCount: pinnedRows.length
      });
    }

    // Extract lead details
    const rec = payload.record || payload.lead || {};
    const oldRec = payload.old_record || payload.old_lead || {};
    const leadId = rec.id || oldRec.id || payload.leadId || "";
    const phone = rec.customer_number || oldRec.customer_number || payload.customer_number || "";
    const name = rec.customer_name || oldRec.customer_name || payload.customer_name || "";

    if (!leadId && !phone && !name) {
      return jsonResponse({ error: "Missing lead identifier (id, phone, or name)" }, 400);
    }

    // ── 3. DELETE ACTION ──
    // Deletes row completely and automatically shifts all lower rows UP
    if (eventType === "DELETE") {
      const deletedFromNew = deleteLeadRow(sheetNew, leadId, phone, name);
      const deletedFromPinned = deleteLeadRow(sheetPinned, leadId, phone, name);
      return jsonResponse({
        success: true,
        action: "DELETED",
        leadId: leadId,
        rowsShifted: true,
        deletedFromNew: deletedFromNew,
        deletedFromPinned: deletedFromPinned
      });
    }

    // Check status
    const status = (rec.cs_status || "").toLowerCase();
    const isNewToContact = status === "new" || status === "new to contact";

    // If status is changed to anything other than "new" (e.g. contacted, booked, lost),
    // remove it from both "New to Contact" and "Pinned Important" sheets, shifting rows up!
    if (!isNewToContact) {
      deleteLeadRow(sheetNew, leadId, phone, name);
      deleteLeadRow(sheetPinned, leadId, phone, name);
      return jsonResponse({
        success: true,
        action: "REMOVED_STATUS_NOT_NEW",
        status: rec.cs_status,
        rowsShifted: true
      });
    }

    const rowValues = leadToRow(rec);
    const isPinned = (rec.pinned_important === true);

    // ── 4. UPDATE ACTION ──
    if (eventType === "UPDATE") {
      if (isPinned) {
        deleteLeadRow(sheetNew, leadId, phone, name);
        upsertLeadRow(sheetPinned, leadId, rowValues);
      } else {
        deleteLeadRow(sheetPinned, leadId, phone, name);
        upsertLeadRow(sheetNew, leadId, rowValues);
      }
      return jsonResponse({
        success: true,
        action: "UPDATED",
        sheet: isPinned ? CONFIG.SHEET_PINNED_IMPORTANT : CONFIG.SHEET_NEW_TO_CONTACT
      });
    }

    // ── 5. INSERT ACTION ──
    if (eventType === "INSERT") {
      if (isPinned) {
        deleteLeadRow(sheetNew, leadId, phone, name);
        upsertLeadRow(sheetPinned, leadId, rowValues);
      } else {
        deleteLeadRow(sheetPinned, leadId, phone, name);
        upsertLeadRow(sheetNew, leadId, rowValues);
      }
      return jsonResponse({
        success: true,
        action: "INSERTED",
        sheet: isPinned ? CONFIG.SHEET_PINNED_IMPORTANT : CONFIG.SHEET_NEW_TO_CONTACT
      });
    }

    return jsonResponse({ message: "No matching action handler for: " + eventType });
  } catch (err) {
    return jsonResponse({ error: err.toString(), stack: err.stack }, 500);
  }
}

/**
 * Inserts a lead row at Row 2 (directly below headers, top of table)
 */
function insertLeadAtTop(sheet, rowValues) {
  sheet.insertRowBefore(2);
  sheet.getRange(2, 1, 1, rowValues.length).setValues([rowValues]);
  sheet.setRowHeight(2, 32);
}

/**
 * Updates an existing lead row, or inserts it at Row 2 if not found
 */
function upsertLeadRow(sheet, leadId, rowValues) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    insertLeadAtTop(sheet, rowValues);
    return;
  }

  const cleanId = leadId ? String(leadId).trim().toLowerCase() : "";
  const cleanPhone = rowValues[2] ? String(rowValues[2]).replace(/\D/g, "") : "";
  const cleanName = rowValues[1] ? String(rowValues[1]).trim().toLowerCase() : "";

  const data = sheet.getRange(2, 1, lastRow - 1, CONFIG.HEADERS.length).getValues();
  for (let i = 0; i < data.length; i++) {
    const rowId = String(data[i][12] || "").trim().toLowerCase();
    const rowPhone = String(data[i][2] || "").replace(/\D/g, "");
    const rowName = String(data[i][1] || "").trim().toLowerCase();

    let match = false;
    if (cleanId && rowId && rowId === cleanId) {
      match = true;
    } else if (!cleanId || !rowId) {
      if (cleanPhone && cleanPhone.length >= 7 && rowPhone.includes(cleanPhone)) {
        match = true;
      } else if (cleanName && cleanName.length >= 3 && rowName === cleanName) {
        match = true;
      }
    }

    if (match) {
      const rowPosition = i + 2;
      sheet.getRange(rowPosition, 1, 1, rowValues.length).setValues([rowValues]);
      return;
    }
  }

  // If not found in sheet, insert at top (Row 2)
  insertLeadAtTop(sheet, rowValues);
}

/**
 * Deletes lead row and automatically shifts all rows below it UP
 * Loops backwards to preserve row indices during deletion
 */
function deleteLeadRow(sheet, leadId, fallbackPhone, fallbackName) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;

  const data = sheet.getRange(2, 1, lastRow - 1, CONFIG.HEADERS.length).getValues();
  const cleanId = leadId ? String(leadId).trim().toLowerCase() : "";
  const cleanPhone = fallbackPhone ? String(fallbackPhone).replace(/\D/g, "") : "";
  const cleanName = fallbackName ? String(fallbackName).trim().toLowerCase() : "";

  let deletedCount = 0;

  // Search backwards so deleting a row does not distort subsequent indices
  for (let i = data.length - 1; i >= 0; i--) {
    const rowId = String(data[i][12] || "").trim().toLowerCase();
    const rowPhone = String(data[i][2] || "").replace(/\D/g, "");
    const rowName = String(data[i][1] || "").trim().toLowerCase();

    let match = false;
    if (cleanId && rowId && rowId === cleanId) {
      match = true;
    } else if (cleanPhone && cleanPhone.length >= 7 && rowPhone.includes(cleanPhone)) {
      match = true;
    } else if (cleanName && cleanName.length >= 3 && rowName === cleanName) {
      match = true;
    }

    if (match) {
      const rowPosition = i + 2;
      sheet.deleteRow(rowPosition);
      deletedCount++;
    }
  }

  return deletedCount > 0;
}

function jsonResponse(data, code) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
