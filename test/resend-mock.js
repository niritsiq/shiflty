/* Test double for https://api.resend.com/emails. Loaded with node -r.
   Records the JSON body only. The Authorization value is not written. */
"use strict";
const fs = require("fs");

function readLog(file) {
  if (!file || !fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

const realFetch = global.fetch;
global.fetch = async function (url, opts) {
  const target = String(url);
  if (target !== "https://api.resend.com/emails") {
    if (process.env.RESEND_MOCK_STRICT === "1") {
      throw new Error("unexpected fetch " + target);
    }
    return realFetch.apply(global, arguments);
  }
  const headers = (opts && opts.headers) || {};
  const auth = String(headers.Authorization || headers.authorization || "");
  let body = null;
  if (opts && opts.body) body = JSON.parse(opts.body);
  const file = process.env.RESEND_MOCK_LOG;
  const list = readLog(file);
  list.push({
    url: target,
    method: opts && opts.method,
    authorizationIsBearer: auth.startsWith("Bearer ") && auth.length > "Bearer ".length,
    authorizationLength: auth.length,
    body
  });
  if (file) fs.writeFileSync(file, JSON.stringify(list));
  if (process.env.RESEND_MOCK_MODE === "reject") {
    return new Response(JSON.stringify({
      statusCode: 403,
      name: "validation_error",
      message: "You can only send testing emails to your own email address."
    }), { status: 403, headers: { "content-type": "application/json" } });
  }
  return new Response(JSON.stringify({ id: "email_test_" + list.length }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
};
