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
      window.location.href = '/login';
      return null;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      if (data.reauth) err.reauth = data.reauth; // e.g. 'gmail'
      throw err;
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
    test() { return API.post('/api/email/test'); },
    checkPriorContact(emails) { return API.post('/api/email/check-prior-contact', { emails }); },
    deliverabilityTest(opts) { return API.post('/api/email/deliverability-test', opts || {}); },
    deliverabilityResult(threadId) { return API.get(`/api/email/deliverability-result/${threadId}`); }
  },

  // AI
  ai: {
    outreach(candidateId) { return API.post('/api/ai/outreach', { candidateId }); },
    roleJD(candidateId) { return API.post('/api/ai/role-jd', { candidateId }); },
    resumeReview(candidateId) { return API.post('/api/ai/resume-review', { candidateId }); },
    victory(candidateId) { return API.post('/api/ai/victory', { candidateId }); },
    reply(candidateId, lastMessage) { return API.post('/api/ai/reply', { candidateId, lastMessage }); },
    followup(candidateId) { return API.post('/api/ai/followup', { candidateId }); },
    score(candidateId) { return API.post('/api/ai/score', { candidateId }); }
  },

  // Bulk outreach queue (server-side)
  queue: {
    create(jobs) { return API.post('/api/queue/outreach', { jobs }); },
    status()     { return API.get('/api/queue/outreach'); },
    cancel()     { return API.delete('/api/queue/outreach'); }
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
    addColleague(data) { return API.post('/api/settings/colleague', data); },
    getZohoConnectUrl() { return API.get('/api/settings/zoho-connect'); },
    disconnectZoho() { return API.delete('/api/settings/zoho'); },
    zohoStatus() { return API.get('/api/settings/zoho-status'); }
  },

  // Email Templates
  templates: {
    list()           { return API.get('/api/templates'); },
    create(data)     { return API.post('/api/templates', data); },
    update(id, data) { return API.put(`/api/templates/${id}`, data); },
    delete(id)       { return API.delete(`/api/templates/${id}`); }
  },

  // LinkedIn Import
  linkedin: {
    import(data) { return API.post('/api/linkedin/import', data); },
    bookmarkletResult(token) { return API.get(`/api/linkedin/bookmarklet/${token}`); }
  },

  // Push Notifications
  push: {
    getVapidKey()          { return API.get('/api/push/vapid-key'); },
    subscribe(subscription){ return API.post('/api/push/subscribe', { subscription }); },
    unsubscribe()          { return API.delete('/api/push/subscribe'); }
  }
};
