/**
 * Shared configuration — single source of truth for DATA_DIR.
 *
 * On Railway, set the DATA_DIR environment variable to the path of a
 * persistent volume (e.g. /data). Without it, all user data is stored
 * in the container's ephemeral filesystem and will be lost on every redeploy.
 *
 * Railway setup:
 *   1. Go to your service → Volumes → Add Volume → Mount Path: /data
 *   2. Go to Variables → Add: DATA_DIR = /data
 */

require('dotenv').config();

const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';
const PORT = parseInt(process.env.PORT || '3000', 10);
const IS_PRODUCTION = process.env.NODE_ENV === 'production' || !!process.env.RAILWAY_ENVIRONMENT;

module.exports = { DATA_DIR, BASE_URL, SESSION_SECRET, PORT, IS_PRODUCTION };
