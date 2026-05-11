import { expect, test } from "@playwright/test";

test("skeleton PWA exchanges data through WebSocket development transport", async ({ browser }) => {
  const context = await browser.newContext();
  const host = await context.newPage();
  const guest = await context.newPage();
  const room = `WS-${Date.now()}`;

  await host.goto(
    `http://127.0.0.1:5175/?transport=websocket&role=host&room=${room}&name=HST&peer=host-peer-${room}`,
  );
  await expect(host.getByTestId("status")).toHaveText("Hosting", { timeout: 10_000 });

  await guest.goto(
    `http://127.0.0.1:5175/?transport=websocket&role=guest&room=${room}&name=GST&peer=guest-peer-${room}&host=host-peer-${room}`,
  );
  await expect(guest.getByTestId("status")).toHaveText("Connected", { timeout: 10_000 });
  await expect(host.getByTestId("players")).toContainText("GST");

  await guest.getByTestId("send-input").click();

  await expect(host.getByTestId("last-input")).toContainText("p2:pulse", { timeout: 10_000 });
  await expect(guest.getByTestId("last-snapshot")).toHaveText("p2:1", { timeout: 10_000 });

  await context.close();
});

test("skeleton PWA guest reports host WebSocket disconnect", async ({ browser }) => {
  const context = await browser.newContext();
  const host = await context.newPage();
  const guest = await context.newPage();
  const room = `WS-CLOSE-${Date.now()}`;

  await host.goto(
    `http://127.0.0.1:5175/?transport=websocket&role=host&room=${room}&name=HST&peer=host-peer-${room}`,
  );
  await expect(host.getByTestId("status")).toHaveText("Hosting", { timeout: 10_000 });

  await guest.goto(
    `http://127.0.0.1:5175/?transport=websocket&role=guest&room=${room}&name=GST&peer=guest-peer-${room}&host=host-peer-${room}`,
  );
  await expect(guest.getByTestId("status")).toHaveText("Connected", { timeout: 10_000 });

  await host.close();

  await expect(guest.getByTestId("status")).toHaveText("Disconnected", { timeout: 10_000 });
  await expect(guest.getByTestId("send-input")).toBeDisabled();

  await context.close();
});
