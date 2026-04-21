// ============================================================
//  迪特軍 EV 維修管理系統 — Google Apps Script
//  請將此程式碼完整貼入你的 Google Apps Script 編輯器
//  取代原有的程式碼，然後重新部署（Deploy > New deployment）
// ============================================================

const SHEET_ID = SpreadsheetApp.getActiveSpreadsheet().getId();
const SHEETS = {
  CUSTOMERS: 'Customers',
  REPAIRS: 'Repairs',
  INVENTORY: 'Inventory',
  INTAKE: 'Intake'   // 新增：問卷收件匣
};

// ── 主入口 ────────────────────────────────────────────────────
function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.tryLock(10000);
  try {
    const body = JSON.parse(e.postData.contents);
    const action = body.action;
    let result;

    if      (action === 'read')       result = handleRead();
    else if (action === 'upsert')     result = handleUpsert(body.table, body.data);
    else if (action === 'delete')     result = handleDelete(body.table, body.id);
    else if (action === 'setup')      result = handleSetup();
    else if (action === 'intake')     result = handleIntake(body.data);
    else if (action === 'readIntake') result = handleReadIntake();
    else if (action === 'markIntake') result = handleMarkIntake(body.orderId, body.status);
    else result = { status: 'error', message: 'Unknown action: ' + action };

    return jsonResponse(result);
  } catch(err) {
    return jsonResponse({ status: 'error', message: err.toString() });
  } finally {
    lock.releaseLock();
  }
}

function doGet(e) {
  return jsonResponse({ status: 'ok', message: 'Diter EV API running' });
}

function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── Setup：建立所有工作表 ───────────────────────────────────────
function handleSetup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const needed = [
    { name: SHEETS.CUSTOMERS, headers: ['id','name','phone','address','notes','category','model','plate','vin','specs','purchaseDate','warrantyDays','price','records'] },
    { name: SHEETS.REPAIRS,   headers: ['id','customerId','date','type','status','mileage','description','note','partsCost','laborCost','totalCost'] },
    { name: SHEETS.INVENTORY, headers: ['id','name','category','stock','price','minStock'] },
    { name: SHEETS.INTAKE,    headers: ['orderId','submittedAt','status','name','phone','line','address','model','plate','vin','specs','mileage','purchaseDate','repairType','urgency','symptoms','description','apptDate','apptTime','apptNote','source','importedAt'] },
  ];
  needed.forEach(({ name, headers }) => {
    let sheet = ss.getSheetByName(name);
    if (!sheet) {
      sheet = ss.insertSheet(name);
      sheet.appendRow(headers);
      sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#1a56db').setFontColor('#ffffff');
    }
  });
  return { status: 'success', message: '所有工作表已建立或已存在' };
}

// ── Read：讀取所有資料 ──────────────────────────────────────────
function handleRead() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const result = {};
  const tableMap = {
    customers: SHEETS.CUSTOMERS,
    repairs:   SHEETS.REPAIRS,
    inventory: SHEETS.INVENTORY,
  };
  for (const [key, sheetName] of Object.entries(tableMap)) {
    const sheet = ss.getSheetByName(sheetName);
    if (!sheet) { result[key] = []; continue; }
    const rows = sheet.getDataRange().getValues();
    if (rows.length <= 1) { result[key] = []; continue; }
    const headers = rows[0];
    result[key] = rows.slice(1).map(row => {
      const obj = {};
      headers.forEach((h, i) => {
        if (h === 'records') {
          try { obj[h] = JSON.parse(row[i] || '[]'); } catch { obj[h] = []; }
        } else {
          obj[h] = row[i] !== undefined && row[i] !== null ? String(row[i]) : '';
        }
      });
      return obj;
    }).filter(obj => obj.id);
  }
  return { status: 'success', data: result };
}

// ── Upsert：新增或更新一筆資料 ─────────────────────────────────
function handleUpsert(tableName, data) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(tableName);
  if (!sheet) handleSetup();
  sheet = ss.getSheetByName(tableName);
  if (!sheet) return { status: 'error', message: 'Sheet not found: ' + tableName };

  const rows = sheet.getDataRange().getValues();
  const headers = rows[0];
  const rowData = headers.map(h => {
    if (h === 'records') return JSON.stringify(data[h] || []);
    return data[h] !== undefined ? String(data[h]) : '';
  });

  // Find existing row by id
  const idIdx = headers.indexOf('id');
  const existingRowIdx = rows.slice(1).findIndex(r => String(r[idIdx]) === String(data.id));

  if (existingRowIdx >= 0) {
    sheet.getRange(existingRowIdx + 2, 1, 1, rowData.length).setValues([rowData]);
  } else {
    sheet.appendRow(rowData);
  }
  return { status: 'success' };
}

// ── Delete：刪除一筆資料 ────────────────────────────────────────
function handleDelete(tableName, id) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(tableName);
  if (!sheet) return { status: 'error', message: 'Sheet not found' };
  const rows = sheet.getDataRange().getValues();
  const idIdx = rows[0].indexOf('id');
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][idIdx]) === String(id)) {
      sheet.deleteRow(i + 1);
      return { status: 'success' };
    }
  }
  return { status: 'error', message: 'Row not found' };
}

// ── Intake：接收客戶問卷（這是新的功能）───────────────────────────
function handleIntake(data) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEETS.INTAKE);
  if (!sheet) {
    handleSetup();
    sheet = ss.getSheetByName(SHEETS.INTAKE);
  }

  const c = data.customer   || {};
  const v = data.vehicle    || {};
  const r = data.repair     || {};
  const a = data.appointment|| {};

  const row = [
    data.orderNo                    || '',
    data.submittedAt                || new Date().toISOString(),
    'new',                              // status: new / imported / ignored
    c.name    || '',
    c.phone   || '',
    c.line    || '',
    c.address || '',
    v.model   || '',
    v.plate   || '',
    v.vin     || '',
    v.specs   || '',
    v.mileage || '',
    v.purchaseDate || '',
    r.type    || '',
    r.urgency || '',
    (r.symptoms || []).join('、'),
    r.description || '',
    a.date    || '',
    a.time    || '',
    a.note    || '',
    a.source  || '',
    ''  // importedAt — 填入時間代表已匯入
  ];

  sheet.appendRow(row);
  return { status: 'success', orderNo: data.orderNo };
}

// ── ReadIntake：讀取所有問卷（CRM 用）──────────────────────────
function handleReadIntake() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEETS.INTAKE);
  if (!sheet) return { status: 'success', data: [] };

  const rows = sheet.getDataRange().getValues();
  if (rows.length <= 1) return { status: 'success', data: [] };

  const headers = rows[0];
  const data = rows.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i] !== undefined ? String(row[i]) : ''; });
    return obj;
  }).filter(obj => obj.orderId);

  return { status: 'success', data };
}

// ── MarkIntake：標記問卷狀態 ────────────────────────────────────
function handleMarkIntake(orderId, status) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEETS.INTAKE);
  if (!sheet) return { status: 'error', message: 'Intake sheet not found' };

  const rows = sheet.getDataRange().getValues();
  const headers = rows[0];
  const orderIdIdx = headers.indexOf('orderId');
  const statusIdx  = headers.indexOf('status');
  const importedIdx = headers.indexOf('importedAt');

  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][orderIdIdx]) === String(orderId)) {
      sheet.getRange(i + 1, statusIdx + 1).setValue(status);
      if (status === 'imported') {
        sheet.getRange(i + 1, importedIdx + 1).setValue(new Date().toISOString());
      }
      return { status: 'success' };
    }
  }
  return { status: 'error', message: 'Order not found' };
}
