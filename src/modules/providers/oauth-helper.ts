import { AuthToken } from "../core/types";
import { log, logError } from "../utils/logger";
import { generateUUID } from "../utils/uuid";

/**
 * Shared OAuth 2.0 helper for cloud providers.
 *
 * Flow: Opens browser for user authorization → receives code via localhost
 * redirect → exchanges code for tokens → stores tokens in credential manager.
 *
 * Since Zotero runs in a Gecko sandbox, we use Zotero.launchURL() to open the
 * browser and a localhost HTTP server to receive the authorization callback.
 */

/** OAuth configuration per provider */
export interface OAuthConfig {
  providerName: string;
  authUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret?: string; // Not needed for PKCE flows
  scopes: string[];
  redirectPort: number;
  usePKCE: boolean;
  extraAuthParams?: Record<string, string>;
}

/**
 * Generate a PKCE code verifier (43-128 chars, unreserved URI characters)
 */
export function generateCodeVerifier(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return base64UrlEncode(array);
}

/**
 * Generate a PKCE code challenge from verifier (S256 method)
 */
export async function generateCodeChallenge(
  verifier: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncode(new Uint8Array(digest));
}

/** Base64 URL encoding (no padding, URL-safe characters) */
function base64UrlEncode(buffer: Uint8Array): string {
  let binary = "";
  for (const byte of buffer) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Start OAuth flow:
 * 1. Open browser with auth URL
 * 2. Listen on localhost for redirect with auth code
 * 3. Exchange code for tokens
 */
export async function startOAuthFlow(config: OAuthConfig): Promise<AuthToken> {
  const state = generateUUID();
  let codeVerifier: string | undefined;
  let codeChallenge: string | undefined;

  if (config.usePKCE) {
    codeVerifier = generateCodeVerifier();
    codeChallenge = await generateCodeChallenge(codeVerifier);
  }

  const redirectUri = `http://localhost:${config.redirectPort}/oauth/callback`;

  // Build authorization URL
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: config.scopes.join(" "),
    state,
  });

  if (config.usePKCE && codeChallenge) {
    params.set("code_challenge", codeChallenge);
    params.set("code_challenge_method", "S256");
  }

  if (config.extraAuthParams) {
    for (const [key, value] of Object.entries(config.extraAuthParams)) {
      params.set(key, value);
    }
  }

  const authUrl = `${config.authUrl}?${params.toString()}`;

  log(`OAuth: Starting flow for ${config.providerName}, redirect: http://localhost:${config.redirectPort}/oauth/callback`);

  // Wait for the authorization code via localhost callback
  const code = await waitForAuthCode(config.redirectPort, state, authUrl);

  // Exchange code for tokens
  return exchangeCodeForTokens(
    config,
    code,
    redirectUri,
    codeVerifier,
  );
}

/**
 * Listen for OAuth redirect callback.
 *
 * Port 23119 is Zotero's built-in Connector HTTP server — we CANNOT create
 * a second socket on it. For that port, we register a temporary endpoint on
 * Zotero.Server.Endpoints. For all other ports, we create a standalone
 * nsIServerSocket.
 */
async function waitForAuthCode(
  port: number,
  expectedState: string,
  authUrl: string,
): Promise<string> {
  if (port === 23119) {
    return waitViaZoteroServer(expectedState, authUrl);
  }
  return waitViaSocket(port, expectedState, authUrl);
}

/** Use Zotero's built-in HTTP server (port 23119) */
function waitViaZoteroServer(
  expectedState: string,
  authUrl: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const endpointPath = "/oauth/callback";
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      delete Zotero.Server.Endpoints[endpointPath];
      reject(new Error("OAuth timeout — no callback received within 5 minutes"));
    }, 300000);

    function handleCallback(query: Record<string, string>): string {
      clearTimeout(timeout);
      delete Zotero.Server.Endpoints[endpointPath];

      const code = query.code || "";
      const state = query.state || "";
      const error = query.error || "";

      if (error) {
        let errorMsg = `OAuth error: ${error}`;
        if (error === "access_denied") {
          errorMsg += " — For Google: make sure your email is added as a Test User in the Google Cloud Console OAuth consent screen.";
        }
        if (!settled) { settled = true; reject(new Error(errorMsg)); }
        return "<html><body><h2>Authorization Failed</h2><p>You can close this tab.</p></body></html>";
      }
      if (state !== expectedState) {
        if (!settled) { settled = true; reject(new Error("OAuth state mismatch")); }
        return "<html><body><h2>State Mismatch</h2><p>Please try again.</p></body></html>";
      }
      if (code) {
        if (!settled) { settled = true; resolve(code); }
        return "<html><body><h2>ZotCloud Authorized!</h2><p>You can close this tab and return to Zotero.</p></body></html>";
      }
      if (!settled) { settled = true; reject(new Error("No authorization code received")); }
      return "<html><body><h2>Error</h2><p>No code received.</p></body></html>";
    }

    // Register endpoint — supports BOTH Zotero Server API styles:
    // Old: init(queryString, sendResponseCallback)
    // New: init({method, pathname, query, headers, data}) → [code, type, body]
    Zotero.Server.Endpoints[endpointPath] = function () {} as any;
    (Zotero.Server.Endpoints[endpointPath] as any).prototype = {
      supportedMethods: ["GET"],
      init(dataOrOptions: any, sendResponseCallback?: any) {
        let query: Record<string, string>;

        if (typeof dataOrOptions === "string") {
          // Old API: dataOrOptions is the query string
          query = {};
          try {
            const params = new URLSearchParams(dataOrOptions);
            params.forEach((v, k) => { query[k] = v; });
          } catch { /* */ }
        } else if (dataOrOptions && typeof dataOrOptions === "object" && dataOrOptions.query) {
          // New API: dataOrOptions is options object
          query = dataOrOptions.query;
        } else {
          query = {};
        }

        const html = handleCallback(query);

        // Respond via callback (old API) or return (new API)
        if (typeof sendResponseCallback === "function") {
          sendResponseCallback(200, "text/html", html);
        }
        return [200, "text/html", html];
      },
    };

    Zotero.launchURL(authUrl);
  });
}

/**
 * Use a standalone server socket (any port except 23119).
 *
 * IMPORTANT: Parse the HTTP request in onDataAvailable instead of onStopRequest.
 * HTTP/1.1 keep-alive means the browser may not close the connection immediately
 * after the redirect, so onStopRequest would hang until the connection times out.
 * We parse as soon as we have a complete request line (GET /oauth/callback?... HTTP/x.x).
 */
function waitViaSocket(
  port: number,
  expectedState: string,
  authUrl: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const serverSocket = Components.classes[
      "@mozilla.org/network/server-socket;1"
    ].createInstance(Components.interfaces.nsIServerSocket);

    try {
      serverSocket.init(port, true, 1);
      log(`OAuth: Listening on port ${port} for callback`);
    } catch (err: any) {
      log(`OAuth: Failed to bind port ${port}: ${err.message || err}`);
      reject(new Error(`Cannot bind OAuth callback port ${port}: ${err.message || err}`));
      return;
    }

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { serverSocket.close(); } catch { /* ok */ }
      reject(new Error("OAuth timeout — no callback received within 5 minutes"));
    }, 300000);

    function processCallback(
      urlMatch: RegExpMatchArray,
      transport: any,
    ): void {
      const callbackParams = new URLSearchParams(urlMatch[1]);
      const code = callbackParams.get("code");
      const state = callbackParams.get("state");
      const error = callbackParams.get("error");

      const html = error
        ? "<html><body><h2>Authorization Failed</h2><p>You can close this tab.</p></body></html>"
        : "<html><body><h2>ZotCloud Authorized!</h2><p>You can close this tab and return to Zotero.</p></body></html>";

      const response =
        `HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: ${html.length}\r\nConnection: close\r\n\r\n${html}`;

      try {
        const outputStream = transport.openOutputStream(0, 0, 0);
        outputStream.write(response, response.length);
        outputStream.close();
      } catch { /* transport may already be closed */ }

      clearTimeout(timeout);
      try { serverSocket.close(); } catch { /* ok */ }

      if (settled) return;
      settled = true;

      if (error) {
        reject(new Error(`OAuth error: ${error}`));
      } else if (state !== expectedState) {
        reject(new Error("OAuth state mismatch"));
      } else if (code) {
        resolve(code);
      } else {
        reject(new Error("No authorization code received"));
      }
    }

    serverSocket.asyncListen({
      onSocketAccepted(_socket: any, transport: any) {
        log("OAuth: Connection received on callback socket");
        const inputStream = transport.openInputStream(0, 0, 0);
        const scriptableInput = Components.classes[
          "@mozilla.org/scriptableinputstream;1"
        ].createInstance(Components.interfaces.nsIScriptableInputStream);
        scriptableInput.init(inputStream);

        const pump = Components.classes[
          "@mozilla.org/network/input-stream-pump;1"
        ].createInstance(Components.interfaces.nsIInputStreamPump);
        pump.init(inputStream, 0, 0, false);

        let requestData = "";
        let processed = false;

        pump.asyncRead({
          onDataAvailable(_request: any, _stream: any, _offset: any, count: number) {
            requestData += scriptableInput.read(count);

            // Parse immediately when we have a complete request line
            if (!processed) {
              const firstLine = requestData.split("\r\n")[0] || "";
              const urlMatch = firstLine.match(/GET \/oauth\/callback\?(.+) HTTP/);
              if (urlMatch) {
                processed = true;
                processCallback(urlMatch, transport);
              }
            }
          },
          onStartRequest() {},
          onStopRequest() {
            // Fallback: if data arrived in one chunk and onDataAvailable
            // didn't trigger (edge case), try parsing here
            if (!processed && !settled) {
              const firstLine = requestData.split("\r\n")[0] || "";
              const urlMatch = firstLine.match(/GET \/oauth\/callback\?(.+) HTTP/);
              if (urlMatch) {
                processed = true;
                processCallback(urlMatch, transport);
              }
            }

            try { inputStream.close(); } catch { /* ok */ }
            try { transport.close(0); } catch { /* ok */ }
          },
        });
      },
      onStopListening() {},
    });

    log("OAuth: Opening browser for authorization...");
    Zotero.launchURL(authUrl);
    log("OAuth: Browser launched, waiting for callback on port " + port);
  });
}

/** Exchange authorization code for access + refresh tokens */
async function exchangeCodeForTokens(
  config: OAuthConfig,
  code: string,
  redirectUri: string,
  codeVerifier?: string,
): Promise<AuthToken> {
  const body: Record<string, string> = {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: config.clientId,
  };

  if (config.clientSecret) {
    body.client_secret = config.clientSecret;
  }
  if (codeVerifier) {
    body.code_verifier = codeVerifier;
  }

  const response = await fetch(config.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Token exchange failed: ${response.status} ${errorBody}`);
  }

  const data = await response.json();

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
    tokenType: data.token_type || "Bearer",
  };
}

/** Refresh an access token using a refresh token */
export async function refreshAccessToken(
  config: OAuthConfig,
  refreshToken: string,
): Promise<AuthToken> {
  const body: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: config.clientId,
  };

  if (config.clientSecret) {
    body.client_secret = config.clientSecret;
  }

  const response = await fetch(config.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });

  if (!response.ok) {
    throw new Error(`Token refresh failed: ${response.status}`);
  }

  const data = await response.json();

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
    tokenType: data.token_type || "Bearer",
  };
}

/** Store OAuth tokens in credential manager */
export function storeTokens(
  providerName: string,
  token: AuthToken,
): void {
  try {
    const loginManager = Components.classes[
      "@mozilla.org/login-manager;1"
    ].getService(Components.interfaces.nsILoginManager);

    // Remove existing
    removeTokens(providerName);

    const loginInfo = Components.classes[
      "@mozilla.org/login-manager/loginInfo;1"
    ].createInstance(Components.interfaces.nsILoginInfo);

    loginInfo.init(
      "chrome://zotcloud",
      null,
      `ZotCloud ${providerName}`,
      "oauth",
      JSON.stringify(token),
      "",
      "",
    );

    loginManager.addLogin(loginInfo);
  } catch (err) {
    logError("Failed to store OAuth tokens", err);
    // Fallback to prefs
    Zotero.Prefs.set(
      `extensions.zotcloud.${providerName.toLowerCase()}._token`,
      JSON.stringify(token),
    );
  }
}

/** Load stored OAuth tokens */
export function loadTokens(providerName: string): AuthToken | null {
  try {
    const loginManager = Components.classes[
      "@mozilla.org/login-manager;1"
    ].getService(Components.interfaces.nsILoginManager);

    const logins = loginManager.findLogins(
      "chrome://zotcloud",
      null,
      `ZotCloud ${providerName}`,
    );

    if (logins.length > 0) {
      return JSON.parse(logins[0].password);
    }
  } catch {
    // Fallback to prefs
    const stored = Zotero.Prefs.get(
      `extensions.zotcloud.${providerName.toLowerCase()}._token`,
    ) as string;
    if (stored) {
      try {
        return JSON.parse(stored);
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Remove stored OAuth tokens */
export function removeTokens(providerName: string): void {
  try {
    const loginManager = Components.classes[
      "@mozilla.org/login-manager;1"
    ].getService(Components.interfaces.nsILoginManager);

    const logins = loginManager.findLogins(
      "chrome://zotcloud",
      null,
      `ZotCloud ${providerName}`,
    );

    for (const login of logins) {
      loginManager.removeLogin(login);
    }
  } catch {
    Zotero.Prefs.clear(
      `extensions.zotcloud.${providerName.toLowerCase()}._token`,
    );
  }
}
