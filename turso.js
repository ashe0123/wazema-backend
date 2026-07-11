/**
 * turso.js — Lightweight Turso HTTP client using Node built-in https
 * No extra npm packages required. Uses Turso's HTTP API directly.
 */
const https = require('https');

class TursoClient {
  constructor(dbUrl, authToken) {
    // Convert libsql:// → https://
    this.baseUrl   = dbUrl.replace(/^libsql:\/\//, 'https://');
    this.authToken = authToken;
  }

  _request(body) {
    return new Promise((resolve, reject) => {
      const endpoint = new URL(this.baseUrl + '/v2/pipeline');
      const payload  = JSON.stringify(body);
      const opts = {
        hostname: endpoint.hostname,
        path:     endpoint.pathname + endpoint.search,
        method:   'POST',
        headers: {
          'Authorization': 'Bearer ' + this.authToken,
          'Content-Type':  'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      };
      const req = https.request(opts, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString());
            resolve({ status: res.statusCode, data });
          } catch(e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  async execute(sql, args = []) {
    const body = {
      requests: [
        { type: 'execute', stmt: { sql, args: args.map(v => this._val(v)) } },
        { type: 'close' },
      ],
    };
    const { status, data } = await this._request(body);
    if (status !== 200) throw new Error(`Turso HTTP ${status}: ${JSON.stringify(data)}`);
    const result = data.results[0];
    if (result.type === 'error') throw new Error(result.error.message);
    return result.response.result;
  }

  async batch(statements) {
    const requests = statements.map(s => ({
      type: 'execute',
      stmt: { sql: s.sql, args: (s.args || []).map(v => this._val(v)) },
    }));
    requests.push({ type: 'close' });
    const { status, data } = await this._request({ requests });
    if (status !== 200) throw new Error(`Turso HTTP ${status}: ${JSON.stringify(data)}`);
    return data.results.filter(r => r.type !== 'close');
  }

  _val(v) {
    if (v === null || v === undefined) return { type: 'null' };
    if (typeof v === 'number') return Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v };
    if (typeof v === 'boolean') return { type: 'integer', value: v ? '1' : '0' };
    return { type: 'text', value: String(v) };
  }
}

module.exports = TursoClient;
