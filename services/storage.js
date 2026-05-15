const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../config');

// Ensure DATA_DIR exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

async function readJSON(filename) {
  const filePath = path.join(DATA_DIR, filename);
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, 'utf8');
    const trimmed = raw.trim();
    if (!trimmed) return [];
    return JSON.parse(trimmed);
  } catch (err) {
    console.error(`Error reading ${filename}:`, err.message);
    return [];
  }
}

async function writeJSON(filename, data) {
  const filePath = path.join(DATA_DIR, filename);
  const tmpPath = filePath + '.tmp';
  const json = JSON.stringify(data, null, 2);
  fs.writeFileSync(tmpPath, json, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

async function getAllUsers() {
  const result = await readJSON('users.json');
  return Array.isArray(result) ? result : [];
}

async function saveAllUsers(users) {
  await writeJSON('users.json', users);
}

async function getUserById(id) {
  const users = await getAllUsers();
  return users.find(u => u.id === id) || null;
}

async function getUserByEmail(email) {
  const users = await getAllUsers();
  return users.find(u => u.email && u.email.toLowerCase() === email.toLowerCase()) || null;
}

async function saveUser(user) {
  const users = await getAllUsers();
  const idx = users.findIndex(u => u.id === user.id);
  if (idx >= 0) {
    users[idx] = user;
  } else {
    users.push(user);
  }
  await saveAllUsers(users);
}

async function getAllCandidates() {
  const result = await readJSON('candidates.json');
  return Array.isArray(result) ? result : [];
}

async function saveAllCandidates(candidates) {
  await writeJSON('candidates.json', candidates);
}

async function getUserCandidates(userId) {
  const candidates = await getAllCandidates();
  return candidates.filter(c => c.userId === userId);
}

async function getCandidateById(id) {
  const candidates = await getAllCandidates();
  return candidates.find(c => c.id === id) || null;
}

async function saveCandidate(candidate) {
  const candidates = await getAllCandidates();
  candidate.updatedAt = new Date().toISOString();
  const idx = candidates.findIndex(c => c.id === candidate.id);
  if (idx >= 0) {
    candidates[idx] = candidate;
  } else {
    candidates.push(candidate);
  }
  await saveAllCandidates(candidates);
}

module.exports = {
  readJSON,
  writeJSON,
  getAllUsers,
  saveAllUsers,
  getUserById,
  getUserByEmail,
  saveUser,
  getAllCandidates,
  saveAllCandidates,
  getUserCandidates,
  getCandidateById,
  saveCandidate,
  DATA_DIR
};
