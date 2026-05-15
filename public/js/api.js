/* ============================================================
   Welltower Recruiter — API Client
   ============================================================ */

const API = {
  async request(method, url, body, isFormData = false) {
    const opts = {
      method,
      credentials: 'same-origin',
      headers: isFormData ? {} : { 'Content-Type': 'application/json' }
    };
    if (body) {
      opts.body = isFormData ? body : JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    if (res.status === 401) {
      window.location.href = '/';
      return null;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    return data;
  },

  get(url) { return this.request('GET', url); },
  post(url, body) { return this.request('POST', url, body); },
  put(url, body) { return this.request('PUT', url, body); },
  delete(url) { return this.request('DELETE', url); },
  postForm(url, formData) { return this.request('POST', url, formData, true); },

  // Auth
  auth: {
    me() { return API.get('/api/auth/me'); },
    login(email, password) { return API.post('/api/auth/login', { email, password }); },
    register(name, email, password) { return API.post('/api/auth/register', { name, email, password }); },
    logout() { return API.post('/api/auth/logout'); }
  },

  // Candidates
  candidates: {
    list() { return API.get('/api/candidates'); },
    create(data) { return API.post('/api/candidates', data); },
    update(id, data) { return API.put(`/api/candidates/${id}`, data); },
    delete(id) { return API.delete(`/api/candidates/${id}`); },
    import(formData) { return API.postForm('/api/candidates/import', formData); },
    uploadResume(id, formData) { return API.postForm(`/api/candidates/${id}/resume`, formData); },
    downloadResume(id) { window.open(`/api/candidates/${id}/resume/download`, '_blank'); },
    addThread(id, data) { return API.post(`/api/candidates/${id}/thread`, data); },
    bulkStage(ids, stage) { return API.post('/api/candidates/bulk-update', { ids, stage }); }
  },

  // Email
  email: {
    getConnectUrl() { return API.get('/api/email/connect'); },
    send(data) { return API.post('/api/email/send', data); },
    fetch() { return API.post('/api/email/fetch'); },
    test() { return API.post('/api/email/test'); }
  },

  // AI
  ai: {
    outreach(candidateId) { return API.post('/api/ai/outreach', { candidateId }); },
    roleJD(candidateId) { return API.post('/api/ai/role-jd', { candidateId }); },
    resumeReview(candidateId) { return API.post('/api/ai/resume-review', { candidateId }); },
    victory(candidateId) { return API.post('/api/ai/victory', { candidateId }); },
    reply(candidateId, lastMessage) { return API.post('/api/ai/reply', { candidateId, lastMessage }); },
    score(candidateId) { return API.post('/api/ai/score', { candidateId }); }
  },

  // Analytics
  analytics: {
    get() { return API.get('/api/analytics'); }
  },

  // Settings
  settings: {
    get() { return API.get('/api/settings'); },
    update(data) { return API.put('/api/settings', data); },
    gmailStatus() { return API.get('/api/settings/gmail-status'); },
    disconnectGmail() { return API.delete('/api/settings/gmail'); },
    addColleague(data) { return API.post('/api/settings/colleague', data); }
  }
};
