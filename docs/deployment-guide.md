# Self-Hosted VPS Deployment & Security Guide

## 1. Server Provisioning & Memory Management
- **OS:** Ubuntu Linux VPS
- **Container Runtime:** Docker & Docker Compose for isolating `n8n`, `Typebot`, and the WhatsApp gateway service on an internal Docker bridge network.
- **Swap Configuration:** Provisioned a `4GB` swap file (`/swapfile4g`) to prevent out-of-memory (OOM) crashes during concurrent webhook execution and container builds.

## 2. Internal Service Routing
- Containers communicate over internal Docker DNS (`http://<gateway-container>:3001/send-message`) rather than exposing internal messaging ports to the public internet.
- Public webhook endpoints are routed behind HTTPS with a shared secret header/payload check (`YOUR_INTERNAL_WEBHOOK_SECRET`) to reject unauthorized requests.

## 3. Google Workspace Authentication
- **Google Sheets:** Authenticated via a dedicated Google Cloud Service Account with write access scoped strictly to the booking log spreadsheet.
- **Google Calendar:** Authenticated via OAuth2 with queries scoped to `Africa/Johannesburg` (`SAST / UTC+2`) time windows.