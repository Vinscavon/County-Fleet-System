import { getErpSettings } from '../settings.js';

/* Typical target object names per ERP. The exact objects are confirmed with the county's ERP team. */
export const PROFILES = {
  sap: { name: 'SAP S/4HANA', obj: { fuel: 'Vendor invoice posting (FI)', maint: 'Maintenance order (PM)', asset: 'Asset master (FI-AA)' } },
  d365: { name: 'Microsoft Dynamics 365 Finance', obj: { fuel: 'Vendor invoice journal', maint: 'Work order (Asset management)', asset: 'Fixed asset' } },
  oracle: { name: 'Oracle Fusion Cloud', obj: { fuel: 'Payables invoice', maint: 'Maintenance work order', asset: 'Fixed asset' } },
  odoo: { name: 'Odoo', obj: { fuel: 'Vendor bill', maint: 'Maintenance request', asset: 'Asset (account.asset)' } },
  ifmis: { name: 'IFMIS (county finance)', obj: { fuel: 'Payment voucher', maint: 'Requisition / LPO', asset: 'Asset register entry' } },
  rest: { name: 'Other ERP (REST API)', obj: { fuel: 'Expense voucher', maint: 'Work order and requisition', asset: 'Fixed asset record' } },
};

/** Build the document sent to the ERP. Business data is frozen when the event happens; target names and
 *  ledger accounts come from the current settings so Finance can fix a mapping and retry. */
export function buildEnvelope(db, row) {
  const settings = getErpSettings(db);
  const profile = PROFILES[settings.profile] || PROFILES.rest;
  const data = JSON.parse(row.data);
  const asset = row.asset_id ? db.prepare('SELECT * FROM assets WHERE id = ?').get(row.asset_id) : null;

  const env = {
    idempotencyKey: row.idempotency_key,
    source: 'county-fleet',
    event: row.kind,
    reference: row.ref,
    date: data.date,
    target: { system: profile.name, object: profile.obj[row.kind] },
  };
  if (asset) {
    env.asset = {
      fleetId: asset.plate,
      erpAssetNo: asset.erp_asset_no,
      type: asset.type,
      costCentre: data.cost_centre || asset.cost_centre,
    };
  }
  env.currency = 'KES';

  if (row.kind === 'fuel') {
    env.lines = [{ description: `Diesel, ${data.litres} L at KES ${data.unit_price}`, quantity: data.litres, unit: 'L', unitPrice: data.unit_price, amount: data.total }];
    env.total = data.total;
    env.ledger = { account: settings.mapping.fuel };
    env.meterReading = data.meter_reading ?? null;
    env.driver = data.driver_name ?? null;
  } else if (row.kind === 'maint') {
    env.phase = data.phase;
    env.description = data.description;
    env.category = data.category;
    env.lines = data.lines || [];
    env.total = data.total || 0;
    env.ledger = { account: settings.mapping.maint };
    if (data.technician) env.technician = data.technician;
  } else if (row.kind === 'asset') {
    env.changes = data.changes;
    env.ledger = { account: settings.mapping.asset };
  }
  if (row.override) env.override = true;
  return env;
}
