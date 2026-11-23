// lib/zohoAuth.js
// Shared Zoho Books OAuth 2.0 helper for IRSCL
const fs = require('fs');
const path = require('path');

const TOKENS_PATH = process.env.VERCEL ? '/tmp/tokens.json' : path.join(process.cwd(), 'tokens.json');

const CLIENT_ID = process.env.ZOHO_CLIENT_ID || '';
const CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || '';
const ORG_ID = process.env.ZOHO_ORG_ID || '851035268';

const ACCOUNTS_URL = 'https://accounts.zoho.com';
const API_URL = 'https://www.zohoapis.com/books/v3';

let cachedToken = null;
let cachedTokenExpiresAt = 0;
const tokenCache = new Map();
const pendingRefreshPromises = new Map();

function getStoredTokens(customRefreshToken) {
  let rt = (customRefreshToken && String(customRefreshToken).trim());
  let fileTokens = null;
  try {
    if (fs.existsSync(TOKENS_PATH)) {
      fileTokens = JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8'));
    }
  } catch (_) {}

  // If rt is missing or too short
  const isInvalid = !rt || rt.length < 20;
  if (isInvalid) {
    if (fileTokens && fileTokens.refresh_token && fileTokens.refresh_token.length > 20) {
      rt = fileTokens.refresh_token;
    } else if (process.env.ZOHO_REFRESH_TOKEN && process.env.ZOHO_REFRESH_TOKEN.length > 20) {
      rt = process.env.ZOHO_REFRESH_TOKEN;
    } else {
      rt = '';
    }
  }

  const fileAccess = (fileTokens && fileTokens.access_token) || process.env.ZOHO_ACCESS_TOKEN || '';
  const fileExpires = (fileTokens && fileTokens.expires_at) || parseInt(process.env.ZOHO_EXPIRES_AT || '0', 10);

  return {
    refresh_token: rt,
    access_token: fileAccess,
    expires_at: fileExpires,
  };
}

function saveTokens(tokens) {
  cachedToken = tokens.access_token;
  cachedTokenExpiresAt = tokens.expires_at;
  try {
    fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2));
  } catch (_) {}
  try {
    const envPath = path.join(process.cwd(), '.env');
    if (fs.existsSync(envPath) && tokens.refresh_token) {
      let envContent = fs.readFileSync(envPath, 'utf8');
      if (envContent.includes('ZOHO_REFRESH_TOKEN=')) {
        envContent = envContent.replace(/ZOHO_REFRESH_TOKEN=.*/, `ZOHO_REFRESH_TOKEN=${tokens.refresh_token}`);
      } else {
        envContent += `\nZOHO_REFRESH_TOKEN=${tokens.refresh_token}\n`;
      }
      fs.writeFileSync(envPath, envContent, 'utf8');
    }
  } catch (_) {}
}

async function refreshAccessToken(refreshToken, clientId, clientSecret, accountsServer) {
  const cId = clientId || CLIENT_ID;
  const cSec = clientSecret || CLIENT_SECRET;
  const baseAccounts = accountsServer || ACCOUNTS_URL;
  const url = `${baseAccounts}/oauth/v2/token?refresh_token=${encodeURIComponent(refreshToken)}&client_id=${encodeURIComponent(cId)}&client_secret=${encodeURIComponent(cSec)}&grant_type=refresh_token`;

  const res = await fetch(url, { method: 'POST' });
  const data = await res.json();
  if (!data.access_token) {
    const desc = data.error_description || data.error || JSON.stringify(data);
    throw new Error('Failed to refresh Zoho token: ' + desc);
  }

  // Zoho tokens expire in 3600s (1 hour). Cache for 55 minutes (3300s).
  const expiresAt = Date.now() + Math.max(300, ((data.expires_in || 3600) - 300)) * 1000;

  cachedToken = data.access_token;
  cachedTokenExpiresAt = expiresAt;

  tokenCache.set(refreshToken, {
    access_token: data.access_token,
    expires_at: expiresAt,
  });

  const tokens = getStoredTokens(refreshToken) || {};
  tokens.refresh_token = refreshToken;
  tokens.access_token = data.access_token;
  tokens.expires_at = expiresAt;
  saveTokens(tokens);
  return data.access_token;
}

async function getAccessToken(customRefreshToken) {
  const tokens = getStoredTokens(customRefreshToken);
  const rt = tokens.refresh_token;

  if (!rt) {
    const err = new Error('NOT_AUTHORIZED');
    err.code = 'NOT_AUTHORIZED';
    throw err;
  }

  // 1. Check in-memory map cache
  const cached = tokenCache.get(rt);
  if (cached && cached.access_token && Date.now() < cached.expires_at) {
    return cached.access_token;
  }

  // 2. Check global cachedToken
  if (cachedToken && cachedTokenExpiresAt && Date.now() < cachedTokenExpiresAt) {
    tokenCache.set(rt, { access_token: cachedToken, expires_at: cachedTokenExpiresAt });
    return cachedToken;
  }

  // 3. Check persistent tokens.json file cache
  if (tokens.access_token && tokens.expires_at && Date.now() < tokens.expires_at) {
    cachedToken = tokens.access_token;
    cachedTokenExpiresAt = tokens.expires_at;
    tokenCache.set(rt, { access_token: tokens.access_token, expires_at: tokens.expires_at });
    return tokens.access_token;
  }

  // 4. Single-flight mutex: if already refreshing for this rt, reuse the in-flight Promise!
  if (pendingRefreshPromises.has(rt)) {
    return await pendingRefreshPromises.get(rt);
  }

  const p = (async () => {
    try {
      return await refreshAccessToken(rt);
    } finally {
      pendingRefreshPromises.delete(rt);
    }
  })();

  pendingRefreshPromises.set(rt, p);
  return await p;
}

async function apiRequest(method, endpoint, body, orgId, customRefreshToken) {
  const accessToken = await getAccessToken(customRefreshToken);
  let url;
  if (endpoint.startsWith('/organizations')) {
    url = `${API_URL}${endpoint}`;
  } else {
    const separator = endpoint.includes('?') ? '&' : '?';
    url = `${API_URL}${endpoint}${separator}organization_id=${orgId || ORG_ID}`;
  }

  const options = {
    method,
    headers: {
      'Authorization': `Zoho-oauthtoken ${accessToken}`,
      'Content-Type': 'application/json',
    },
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

module.exports = {
  getStoredTokens,
  saveTokens,
  refreshAccessToken,
  getAccessToken,
  apiRequest,
  CLIENT_ID,
  CLIENT_SECRET,
  ORG_ID,
  ACCOUNTS_URL,
  API_URL,
};

