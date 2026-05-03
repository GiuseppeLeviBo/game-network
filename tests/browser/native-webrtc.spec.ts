import { expect, test } from "@playwright/test";

test("skeleton PWA exchanges data through native WebRTC DataChannel transport", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const host = await context.newPage();
  const guest = await context.newPage();
  const room = `NRTC-${Date.now()}`;

  await host.goto(
    `http://127.0.0.1:5175/?transport=native-webrtc&role=host&room=${room}&name=HST&peer=host-peer-${room}`,
  );
  await expect(host.getByTestId("status")).toHaveText("Hosting", { timeout: 10_000 });

  await guest.goto(
    `http://127.0.0.1:5175/?transport=native-webrtc&role=guest&room=${room}&name=GST&peer=guest-peer-${room}&host=host-peer-${room}`,
  );
  await expect(guest.getByTestId("status")).toHaveText("Connected", { timeout: 15_000 });
  await expect(host.getByTestId("players")).toContainText("GST");

  await guest.getByTestId("send-input").click();

  await expect(host.getByTestId("last-input")).toContainText("p2:pulse", { timeout: 10_000 });
  await expect(guest.getByTestId("last-snapshot")).toHaveText("p2:1", { timeout: 10_000 });

  await context.close();
});
