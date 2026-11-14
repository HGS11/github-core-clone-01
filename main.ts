import { createApp } from "./app.ts";

// Wait for a short retry delay.
function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// Stop idle connections before closing the server.
function closeServer(server: ReturnType<typeof createApp>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
    server.closeIdleConnections();
  });
}

// Run the registration and trial lifecycle.
async function run(): Promise<void> {
  let envUrl = process.env.MAKEFUN_ENV_URL;
  if (envUrl !== undefined) envUrl = envUrl.replace(/\/+$/, "");
  if (!envUrl) {
    console.error("MAKEFUN_ENV_URL is required");
    process.exit(1);
  }

  const token = process.env.MAKEFUN_SHOP_TOKEN;
  if (token === undefined) {
    console.error("MAKEFUN_SHOP_TOKEN is required");
    process.exit(1);
  }

  const server = createApp(token);
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(0, () => {
        server.removeListener("error", onError);
        resolve();
      });
    });

    const address = server.address();
    if (address === null || typeof address !== "object"
      || typeof address.port !== "number"
      || !Number.isInteger(address.port)
      || address.port < 1
      || address.port > 65535) {
      throw new Error("Server did not bind a valid ephemeral port");
    }
    const port = address.port;

    // Retry registration until accepted or rejected by contract.
    let registerDelay = 250;
    while (true) {
      let retry = false;
      try {
        const response = await fetch(`${envUrl}/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ port }),
          signal: AbortSignal.timeout(30000),
        });
        if (response.status === 200 || response.status === 409) break;
        if (response.status === 400 || response.status === 405) {
          throw new Error(`Registration contract error: ${response.status}`);
        }
        retry = true;
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("Registration contract error:")) throw error;
        retry = true;
      }
      if (retry) {
        await wait(registerDelay);
        registerDelay = Math.min(registerDelay * 2, 2000);
      }
    }

    // Poll until the environment reports completion.
    let pollDelay = 250;
    while (true) {
      let done = false;
      try {
        const response = await fetch(`${envUrl}/done`, {
          method: "GET",
          signal: AbortSignal.timeout(30000),
        });
        if (response.ok) {
          const body: unknown = await response.json();
          if (body !== null && typeof body === "object"
            && "done" in body && body.done === true) {
            done = true;
          }
        }
      } catch {
        done = false;
      }
      if (done) break;
      await wait(pollDelay);
      pollDelay = Math.min(pollDelay * 2, 2000);
    }

    await closeServer(server);
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Unexpected failure");
    process.exit(1);
  }
}

run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Unexpected failure");
  process.exit(1);
});
