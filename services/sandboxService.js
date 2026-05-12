const axios = require('axios');

class SandboxService {
    constructor() {
        this.apiKey = process.env.SANDBOX_API_KEY;
        this.apiSecret = process.env.SANDBOX_API_SECRET;
        this.baseUrl = 'https://api.sandbox.co.in';
        this.apiVersion = process.env.SANDBOX_API_VERSION || '1.0.0';
        this.token = null;
        this.tokenExpiry = null;
    }

    async authenticate() {
        try {
            // Check if token exists and is not expired (simple 23h check as it lasts 24h)
            if (this.token && this.tokenExpiry > Date.now()) {
                return this.token;
            }

            const response = await axios.post(`${this.baseUrl}/authenticate`, {}, {
                headers: {
                    'x-api-key': this.apiKey,
                    'x-api-secret': this.apiSecret,
                    'x-api-version': this.apiVersion
                }
            });

            if (response.data && response.data.access_token) {
                this.token = response.data.access_token;
                this.tokenExpiry = Date.now() + (23 * 60 * 60 * 1000); // 23 hours from now
                return this.token;
            } else if (response.data && response.data.data && response.data.data.access_token) {
                this.token = response.data.data.access_token;
                this.tokenExpiry = Date.now() + (23 * 60 * 60 * 1000);
                return this.token;
            }
            
            throw new Error('Authentication failed: No token received');
        } catch (error) {
            console.error('Sandbox Auth Error:', error.response?.data || error.message);
            throw new Error('Failed to authenticate with Sandbox');
        }
    }

    async getGstinDetails(gstin) {
        const url = `${this.baseUrl}/gst/compliance/public/gstin/search`;
        try {
            const token = await this.authenticate();
            console.log(`[Sandbox] Fetching GSTIN: ${gstin} from ${url}`);
            
            const response = await axios.post(url, 
            { gstin },
            {
                headers: {
                    'x-api-key': this.apiKey,
                    'Authorization': token,
                    'x-api-version': this.apiVersion,
                    'Content-Type': 'application/json'
                }
            });

            return response.data;
        } catch (error) {
            console.error(`[Sandbox] GSTIN Fetch Error (${url}):`, error.response?.data || error.message);
            throw new Error(error.response?.data?.message || error.response?.data?.error || 'Invalid GSTIN or API error');
        }
    }

    async getEwayBillDetails(ewbNo) {
        const url = `${this.baseUrl}/gst/compliance/public/ewaybill/search?ewbNo=${ewbNo}`;
        try {
            const token = await this.authenticate();
            console.log(`[Sandbox] Fetching E-Way Bill: ${ewbNo} from ${url}`);
            
            const response = await axios.get(url, {
                headers: {
                    'x-api-key': this.apiKey,
                    'Authorization': token,
                    'x-api-version': this.apiVersion
                }
            });

            return response.data;
        } catch (error) {
            console.error(`[Sandbox] EWB Fetch Error (${url}):`, error.response?.data || error.message);
            throw new Error(error.response?.data?.message || 'Invalid E-Way Bill or API error');
        }
    }

    async getEwayBillPdf(ewbNo) {
        const url = `${this.baseUrl}/gst/compliance/public/ewaybill/print?ewbNo=${ewbNo}`;
        try {
            const token = await this.authenticate();
            const response = await axios.get(url, {
                headers: {
                    'x-api-key': this.apiKey,
                    'Authorization': token,
                    'x-api-version': this.apiVersion
                }
            });
            return response.data; // This usually returns a base64 or a link
        } catch (error) {
            console.error(`[Sandbox] EWB PDF Error:`, error.response?.data || error.message);
            throw new Error('Could not fetch E-Way Bill PDF');
        }
    }
}

module.exports = new SandboxService();
