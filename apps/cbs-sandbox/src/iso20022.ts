/** Minimal ISO 20022 helpers: build and read the few messages the TSA–CBS link uses. */

const esc = (s: string) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const unesc = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

/** First text value of <name> inside `xml` (optionally inside the first <within> block). */
export function tag(xml: string, name: string, within?: string): string | null {
  let src = xml;
  if (within) {
    const b = new RegExp(`<${within}(?:\\s[^>]*)?>([\\s\\S]*?)</${within}>`).exec(xml);
    if (!b) return null;
    src = b[1];
  }
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([^<]*)</${name}>`).exec(src);
  return m ? unesc(m[1].trim()) : null;
}

export function attr(xml: string, name: string, attribute: string): string | null {
  const m = new RegExp(`<${name}\\s[^>]*${attribute}="([^"]*)"`).exec(xml);
  return m ? m[1] : null;
}

/** All <name>…</name> blocks. */
export function blocks(xml: string, name: string): string[] {
  return [...xml.matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "g"))].map(m => m[1]);
}

const NS = (m: string) => `urn:iso:std:iso:20022:tech:xsd:${m}`;
const doc = (m: string, body: string) => `<?xml version="1.0" encoding="UTF-8"?>\n<Document xmlns="${NS(m)}">${body}</Document>`;

export interface CreditTransfer {
  msgId: string;
  endToEndId: string;
  amount: number;
  currency: string;
  debtorName: string;
  debtorAccount: string;
  creditorName: string;
  creditorIban: string;
  remittance: string;
  createdAt?: string;
}

/** pacs.008.001.08 – FI to FI customer credit transfer (one transaction). */
export function pacs008(t: CreditTransfer): string {
  const now = t.createdAt ?? new Date().toISOString();
  return doc("pacs.008.001.08",
    `<FIToFICstmrCdtTrf><GrpHdr><MsgId>${esc(t.msgId)}</MsgId><CreDtTm>${now}</CreDtTm><NbOfTxs>1</NbOfTxs>` +
    `<SttlmInf><SttlmMtd>CLRG</SttlmMtd></SttlmInf></GrpHdr>` +
    `<CdtTrfTxInf><PmtId><InstrId>${esc(t.msgId)}</InstrId><EndToEndId>${esc(t.endToEndId)}</EndToEndId></PmtId>` +
    `<IntrBkSttlmAmt Ccy="${esc(t.currency)}">${t.amount.toFixed(2)}</IntrBkSttlmAmt><ChrgBr>SLEV</ChrgBr>` +
    `<Dbtr><Nm>${esc(t.debtorName)}</Nm></Dbtr><DbtrAcct><Id><Othr><Id>${esc(t.debtorAccount)}</Id></Othr></Id></DbtrAcct>` +
    `<Cdtr><Nm>${esc(t.creditorName)}</Nm></Cdtr><CdtrAcct><Id><IBAN>${esc(t.creditorIban)}</IBAN></Id></CdtrAcct>` +
    `<RmtInf><Ustrd>${esc(t.remittance)}</Ustrd></RmtInf></CdtTrfTxInf></FIToFICstmrCdtTrf>`);
}

export function readPacs008(xml: string): CreditTransfer | null {
  const amount = Number(tag(xml, "IntrBkSttlmAmt"));
  const t: CreditTransfer = {
    msgId: tag(xml, "MsgId") ?? "",
    endToEndId: tag(xml, "EndToEndId") ?? "",
    amount,
    currency: attr(xml, "IntrBkSttlmAmt", "Ccy") ?? "",
    debtorName: tag(xml, "Nm", "Dbtr") ?? "",
    debtorAccount: tag(xml, "Id", "Othr") ?? "",
    creditorName: tag(xml, "Nm", "Cdtr") ?? "",
    creditorIban: tag(xml, "IBAN", "CdtrAcct") ?? "",
    remittance: tag(xml, "Ustrd") ?? "",
  };
  if (!t.msgId || !t.endToEndId || !(amount > 0) || !t.currency || !t.creditorIban) return null;
  return t;
}

/** pacs.002.001.10 – payment status report. Status: ACSC settled, ACSP accepted/pending, RJCT rejected. */
export function pacs002(p: { msgId: string; originalMsgId: string; endToEndId: string; status: string; reason?: string; settledAt?: string }): string {
  return doc("pacs.002.001.10",
    `<FIToFIPmtStsRpt><GrpHdr><MsgId>${esc(p.msgId)}</MsgId><CreDtTm>${new Date().toISOString()}</CreDtTm></GrpHdr>` +
    `<TxInfAndSts><OrgnlGrpInf><OrgnlMsgId>${esc(p.originalMsgId)}</OrgnlMsgId><OrgnlMsgNmId>pacs.008.001.08</OrgnlMsgNmId></OrgnlGrpInf>` +
    `<OrgnlEndToEndId>${esc(p.endToEndId)}</OrgnlEndToEndId><TxSts>${p.status}</TxSts>` +
    (p.reason ? `<StsRsnInf><Rsn><Cd>${p.reason}</Cd></Rsn></StsRsnInf>` : "") +
    (p.settledAt ? `<AccptncDtTm>${p.settledAt}</AccptncDtTm>` : "") +
    `</TxInfAndSts></FIToFIPmtStsRpt>`);
}

export function readPacs002(xml: string) {
  return { endToEndId: tag(xml, "OrgnlEndToEndId"), status: tag(xml, "TxSts"), reason: tag(xml, "Cd", "Rsn"), settledAt: tag(xml, "AccptncDtTm") };
}

/** pacs.004.001.09 – payment return (several transactions in one message). */
export function pacs004(msgId: string, returns: Array<{ seq: number; endToEndId: string; amount: number; currency: string; reason: string; at: string }>): string {
  return doc("pacs.004.001.09",
    `<PmtRtr><GrpHdr><MsgId>${esc(msgId)}</MsgId><CreDtTm>${new Date().toISOString()}</CreDtTm><NbOfTxs>${returns.length}</NbOfTxs></GrpHdr>` +
    returns.map(r => `<TxInf><RtrId>RTR-${r.seq}</RtrId><OrgnlEndToEndId>${esc(r.endToEndId)}</OrgnlEndToEndId>` +
      `<RtrdIntrBkSttlmAmt Ccy="${r.currency}">${r.amount.toFixed(2)}</RtrdIntrBkSttlmAmt><IntrBkSttlmDt>${r.at.slice(0, 10)}</IntrBkSttlmDt>` +
      `<RtrRsnInf><Rsn><Cd>${r.reason}</Cd></Rsn></RtrRsnInf></TxInf>`).join("") + `</PmtRtr>`);
}

export function readPacs004(xml: string) {
  return blocks(xml, "TxInf").map(b => ({
    returnId: tag(b, "RtrId"), endToEndId: tag(b, "OrgnlEndToEndId"), amount: Number(tag(b, "RtrdIntrBkSttlmAmt")), reason: tag(b, "Cd"),
  }));
}

export interface StatementEntry { amount: number; currency: string; direction: "DBIT" | "CRDT"; bookingDate: string; endToEndId?: string; remittance?: string }

/** camt.053.001.08 – bank-to-customer statement for one account and day. */
export function camt053(p: { msgId: string; statementId: string; account: string; date: string; opening: number; closing: number; entries: StatementEntry[]; currency?: string }): string {
  const bal = (code: string, amt: number) => `<Bal><Tp><CdOrPrtry><Cd>${code}</Cd></CdOrPrtry></Tp><Amt Ccy="${p.currency ?? "SYP"}">${Math.abs(amt).toFixed(2)}</Amt><CdtDbtInd>${amt >= 0 ? "CRDT" : "DBIT"}</CdtDbtInd><Dt><Dt>${p.date}</Dt></Dt></Bal>`;
  return doc("camt.053.001.08",
    `<BkToCstmrStmt><GrpHdr><MsgId>${esc(p.msgId)}</MsgId><CreDtTm>${new Date().toISOString()}</CreDtTm></GrpHdr>` +
    `<Stmt><Id>${esc(p.statementId)}</Id><Acct><Id><Othr><Id>${esc(p.account)}</Id></Othr></Id></Acct>` +
    bal("OPBD", p.opening) + bal("CLBD", p.closing) +
    p.entries.map(e => `<Ntry><Amt Ccy="${e.currency}">${e.amount.toFixed(2)}</Amt><CdtDbtInd>${e.direction}</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts>` +
      `<BookgDt><Dt>${e.bookingDate}</Dt></BookgDt><NtryDtls><TxDtls>` +
      (e.endToEndId ? `<Refs><EndToEndId>${esc(e.endToEndId)}</EndToEndId></Refs>` : "") +
      (e.remittance ? `<RmtInf><Ustrd>${esc(e.remittance)}</Ustrd></RmtInf>` : "") +
      `</TxDtls></NtryDtls></Ntry>`).join("") + `</Stmt></BkToCstmrStmt>`);
}

export function readCamt053(xml: string) {
  return {
    statementId: tag(xml, "Id", "Stmt"),
    account: tag(xml, "Id", "Othr"),
    entries: blocks(xml, "Ntry").map(b => ({
      amount: Number(tag(b, "Amt")),
      direction: tag(b, "CdtDbtInd") as "DBIT" | "CRDT",
      bookingDate: tag(b, "Dt", "BookgDt") ?? "",
      endToEndId: tag(b, "EndToEndId"),
      remittance: tag(b, "Ustrd"),
    })),
  };
}

/** ISO 13616 IBAN check. */
export function ibanValid(iban: string): boolean {
  const s = iban.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return false;
  let rem = 0;
  for (const ch of s.slice(4) + s.slice(0, 4)) {
    const v = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const d of v) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}
