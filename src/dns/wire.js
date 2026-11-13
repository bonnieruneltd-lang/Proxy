'use strict';

const net = require('node:net');
const { DnsError, clampTtl, sortAddresses, MAX_TTL, NEGATIVE_TTL } = require('./common');

const TYPE = { A: 1, AAAA: 28, CNAME: 5 };
const TYPE_NAME = { 1: 'A', 28: 'AAAA', 5: 'CNAME' };

function encodeName(name) {
  const labels = String(name).replace(/\.$/, '').split('.').filter(Boolean);
  const chunks = [];
  for (const label of labels) {
    const bytes = Buffer.from(label, 'ascii');
    if (bytes.length === 0 || bytes.length > 63) {
      throw new DnsError(`invalid DNS label "${label}"`, 'EBADNAME');
    }
    chunks.push(Buffer.from([bytes.length]), bytes);
  }
  chunks.push(Buffer.from([0x00]));
  return Buffer.concat(chunks);
}

/**
 * Builds an RFC 1035 query message for a single question.
 */
function encodeQuery(name, type = 'A', id = 0) {
  const qtype = TYPE[String(type).toUpperCase()] || TYPE.A;
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id & 0xffff, 0);
  header.writeUInt16BE(0x0100, 2); // recursion desired
  header.writeUInt16BE(1, 4); // QDCOUNT
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(qtype, 0);
  tail.writeUInt16BE(1, 2); // IN
  return Buffer.concat([header, encodeName(name), tail]);
}

/**
 * Reads a (possibly compressed) domain name starting at `offset`.
 * Returns [name, offsetAfterName].
 */
function decodeName(buffer, offset, depth = 0) {
  if (depth > 10) throw new DnsError('DNS name compression loop', 'EBADRESP');
  const labels = [];
  let cursor = offset;
  let after = offset;
  let jumped = false;

  while (cursor < buffer.length) {
    const length = buffer[cursor];
    if (length === 0) {
      cursor += 1;
      if (!jumped) after = cursor;
      break;
    }
    if ((length & 0xc0) === 0xc0) {
      if (cursor + 1 >= buffer.length) throw new DnsError('truncated DNS pointer', 'EBADRESP');
      const pointer = ((length & 0x3f) << 8) | buffer[cursor + 1];
      if (!jumped) after = cursor + 2;
      jumped = true;
      const [target] = decodeName(buffer, pointer, depth + 1);
      if (target) labels.push(target);
      break;
    }
    if (cursor + 1 + length > buffer.length) throw new DnsError('truncated DNS label', 'EBADRESP');
    labels.push(buffer.toString('latin1', cursor + 1, cursor + 1 + length));
    cursor += 1 + length;
    if (!jumped) after = cursor;
  }

  return [labels.filter(Boolean).join('.'), after];
}

function formatIPv6(buffer) {
  const groups = [];
  for (let i = 0; i < 16; i += 2) groups.push(buffer.readUInt16BE(i).toString(16));
  return groups.join(':');
}

/**
 * Decodes an RFC 1035 response into the same shape as the JSON parser.
 */
function decodeResponse(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) {
    throw new DnsError('short DNS response', 'EBADRESP');
  }
  const flags = buffer.readUInt16BE(2);
  const rcode = flags & 0x000f;
  if (flags & 0x0200) throw new DnsError('truncated DNS response', 'ETRUNCATED');

  const qdcount = buffer.readUInt16BE(4);
  const ancount = buffer.readUInt16BE(6);
  let offset = 12;

  for (let i = 0; i < qdcount; i += 1) {
    const [, next] = decodeName(buffer, offset);
    offset = next + 4;
  }

  const answers = [];
  for (let i = 0; i < ancount; i += 1) {
    const [name, afterName] = decodeName(buffer, offset);
    offset = afterName;
    if (offset + 10 > buffer.length) throw new DnsError('truncated DNS record', 'EBADRESP');

    const type = buffer.readUInt16BE(offset);
    const ttl = buffer.readUInt32BE(offset + 4);
    const rdlength = buffer.readUInt16BE(offset + 8);
    offset += 10;
    if (offset + rdlength > buffer.length) throw new DnsError('truncated DNS rdata', 'EBADRESP');

    let data = null;
    if (type === TYPE.A && rdlength === 4) {
      data = `${buffer[offset]}.${buffer[offset + 1]}.${buffer[offset + 2]}.${buffer[offset + 3]}`;
    } else if (type === TYPE.AAAA && rdlength === 16) {
      data = formatIPv6(buffer.subarray(offset, offset + 16));
    } else if (type === TYPE.CNAME) {
      const [target] = decodeName(buffer, offset);
      data = target;
    }

    answers.push({ name, type, ttl, data });
    offset += rdlength;
  }

  return { rcode, answers };
}

function parseWireAnswer(buffer) {
  const { rcode, answers } = decodeResponse(buffer);
  if (rcode === 3) return { addresses: [], ttl: NEGATIVE_TTL, status: 3, name: '' };
  if (rcode !== 0) throw new DnsError(`DNS response status ${rcode}`, 'EDNSSTATUS', { status: rcode });

  const addresses = [];
  let ttl = MAX_TTL;
  for (const record of answers) {
    if (!record.data) continue;
    const family = record.type === TYPE.A ? 4 : record.type === TYPE.AAAA ? 6 : 0;
    if (!family || net.isIP(record.data) !== family) continue;
    addresses.push({ address: record.data, family });
    ttl = Math.min(ttl, clampTtl(record.ttl));
  }
  return { addresses: sortAddresses(addresses), ttl: clampTtl(ttl), status: 0, name: '' };
}

module.exports = {
  TYPE,
  TYPE_NAME,
  encodeName,
  encodeQuery,
  decodeName,
  decodeResponse,
  parseWireAnswer,
  formatIPv6
};
