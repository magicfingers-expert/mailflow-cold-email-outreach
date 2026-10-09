# ✉️ MailFlow • Cold Email Outreach Engine, Unified Inbox & Live Tracker

> **A high-deliverability cold email automation platform with multi-account rotation, anti-spam variation, live IMAP unified inbox, real-time open tracker, bounce suppression, and AES-256 credential security.**

---

## 🌟 Key Features

1. **Compose & Multi-Message Auto-Rotation**:
   * Rotate across 5 distinct outreach variants to bypass spam filters and content hashing.
   * Built-in Spintax syntax support (`{Hi|Hey|Hello}`, `{Quick question|Brief inquiry}`).
   * Adjustable humanized jitter delays (5s, 10s, 15s, 20s, 60s).
   * Stealth Plain-Text mode for maximum primary inbox deliverability.

2. **Unified & Primary Inboxes**:
   * **All Inbox**: Aggregated view of all incoming lead replies across all connected accounts.
   * **Primary Inbox**: Focused view for the active selected account.
   * **Sent Log**: Full historical record of all dispatched outreach and direct replies.
   * **Spam Rescue**: Detects filtered leads in Spam and provides 1-click rescue to Primary Inbox.
   * **Continuous Auto-Sync**: Background IMAP engine checks for replies every 8–10 seconds with audio chime alerts.

3. **👁️ Real-Time Lead Open Tracker**:
   * Top-bar notification bell with instant alerts when leads open messages.
   * Live activity feed with timestamp, open counts, IP, and device user-agent details.
   * Persistent live open notification banner with expandable activity stream.

4. **⚠️ Bounced Leads & Delivery Failure Center**:
   * Automatic detection of hard bounces (550), soft bounces (552), and undeliverable addresses.
   * **Auto-Suppression Engine**: Automatically isolates bounced leads so future campaigns skip them, protecting your domain reputation.
   * Full SMTP diagnostic transcripts and diagnostic error code viewer.

5. **🔐 AES-256-GCM Military-Grade Password Vault**:
   * Stored credentials in `data/accounts.json` are encrypted using AES-256-GCM with a dedicated hardware-bound vault key (`data/.app_vault_key`).
   * Zero plain-text credentials exposed to client APIs or browser `localStorage`.
   * UI shoulder-surfing protection with masked password indicators.

---

## 🚀 Quick Start

### 1. Install Dependencies & Start Server
```bash
npm install
node server.js
```
The application will be live at `http://localhost:3000`.

### 2. Connect Your Sender Accounts
1. Go to **Sender Accounts** or the top-right account pill.
2. Enter your email (e.g. `user@gmail.com`) and 16-character [Google App Password](https://myaccount.google.com/apppasswords).
3. Click **Live Socket Diagnose** to verify TLS 1.3 handshake and authentication.

### 3. Launch Your First Outreach Campaign
1. Paste up to 50 lead emails (one per line) in Step 2.
2. Customize or generate 5 message variants with dynamic Spintax in Step 3.
3. Select your delay preference and click **Send Outreach Campaign**.

---

## 🛠️ Tech Stack
* **Backend**: Node.js, Express, Nodemailer, ImapFlow, AES-256-GCM Security Service
* **Frontend**: Vanilla JavaScript (ES6+), HTML5, Pure Modern CSS (Executive Emerald Theme)
* **Storage**: Local JSON databases with automated persistence and vault encryption

---

## 📄 License
MIT License
