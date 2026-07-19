/**
 * OTP webhook server for Vapi Custom Tools.
 *
 * Exposes ONE endpoint (POST /tools/webhook) that Vapi calls whenever the
 * assistant invokes the "sendOtp" or "verifyOtp" tool. Vapi batches tool
 * calls into a single request as `message.toolCallList`, so this server
 * loops over that list and dispatches by tool name.
 *
 * Response shape required by Vapi:
 *   { "results": [ { "toolCallId": "...", "result": <any> }, ... ] }
 *
 * OTP provider: 2Factor.in — its AUTOGEN endpoint generates + sends the
 * OTP and returns a sessionId; VERIFY checks the caller's spoken code
 * against that sessionId server-side. We never store the OTP ourselves.
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env.local') });
require('dotenv').config();

const express = require('express');
const app = express();

app.use(express.json());


const TWOFACTOR_API_KEY = process.env.TWOFACTOR_API_KEY;
const VAPI_WEBHOOK_SECRET = process.env.VAPI_WEBHOOK_SECRET; // optional

if (!TWOFACTOR_API_KEY) {
  console.warn('[warn] TWOFACTOR_API_KEY is not set. sendOtp/verifyOtp will fail.');
}

// Vapi tool calls have their own timeout, so don't let a slow/unreachable
// OTP provider hang the request indefinitely.
async function fetchWithTimeout(url, ms = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Tool handlers ----------

async function handleSendOtp(args = {}) {
  const { phoneNumber } = args;
  const cleanNumber = String(phoneNumber || '').replace(/\D/g, '').slice(-10);

  if (cleanNumber.length !== 10) {
    return {
      success: false,
      message:
        "That phone number doesn't look right. Please ask the caller for a valid 10-digit mobile number and try again.",
    };
  }

  try {
    const url = `https://2factor.in/API/V1/${TWOFACTOR_API_KEY}/SMS/${cleanNumber}/AUTOGEN`;
    const response = await fetchWithTimeout(url);
    const data = await response.json();

    if (data.Status !== 'Success') {
      return {
        success: false,
        message: data.Details || 'Failed to send the OTP. Please try again.',
      };
    }

    return {
      success: true,
      sessionId: data.Details,
      phoneNumber: cleanNumber,
      message: `OTP sent to ${cleanNumber}. Ask the caller to read back the code, then call verifyOtp with this sessionId and the code they give you.`,
    };
  } catch (err) {
    console.error('sendOtp error:', err);
    return {
      success: false,
      message: 'Could not reach the OTP service right now. Let the caller know there was a technical issue and offer to retry.',
    };
  }
}

async function handleVerifyOtp(args = {}) {
  const { sessionId, otp } = args;

  if (!sessionId || !otp) {
    return {
      success: false,
      message: 'Missing sessionId or otp. Call sendOtp first and pass its sessionId here along with the code the caller read back.',
    };
  }

  const cleanOtp = String(otp).replace(/\D/g, '');

  try {
    const url = `https://2factor.in/API/V1/${TWOFACTOR_API_KEY}/SMS/VERIFY/${sessionId}/${cleanOtp}`;
    const response = await fetchWithTimeout(url);
    const data = await response.json();

    if (data.Status === 'Success' && data.Details === 'OTP Matched') {
      return { success: true, message: 'OTP verified successfully.' };
    }

    return {
      success: false,
      message: 'The code does not match. Ask the caller to read it back again, or offer to resend it.',
    };
  } catch (err) {
    console.error('verifyOtp error:', err);
    return {
      success: false,
      message: 'Could not reach the verification service right now. Ask the caller to try again in a moment.',
    };
  }
}

const TOOL_HANDLERS = {
  sendOtp: handleSendOtp,
  verifyOtp: handleVerifyOtp,
};

// ---------- Webhook route ----------

app.post('/tools/webhook', async (req, res) => {
  // Optional shared-secret check if you configured one in Vapi's tool server settings
  if (VAPI_WEBHOOK_SECRET) {
    const incoming = req.headers['x-vapi-secret'];
    if (incoming !== VAPI_WEBHOOK_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const toolCallList = req.body?.message?.toolCallList || [];

  if (toolCallList.length === 0) {
    return res.status(400).json({ error: 'No toolCallList found in request body' });
  }

  const results = await Promise.all(
    toolCallList.map(async (call) => {
      // FIX 1: Read tool name from call.function.name (Vapi's OpenAI-compatible format)
      const toolName = call.function?.name || call.name;
      const handler = TOOL_HANDLERS[toolName];

      // FIX 2: Parse arguments — Vapi sends them as a JSON string, not an object
      const parsedArgs = typeof call.function?.arguments === 'string'
        ? JSON.parse(call.function.arguments)
        : (call.function?.arguments || call.arguments);

      console.log(`[tool-call] ${toolName} args:`, parsedArgs);

      const result = handler
        ? await handler(parsedArgs)
        : { success: false, message: `Unknown tool: ${toolName}` };

      console.log(`[tool-result] ${toolName}:`, result);

      return { toolCallId: call.id, result };
    })
  );

  res.json({ results });
});

// ---------- Health check ----------

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`OTP webhook server listening on port ${PORT}`);
});