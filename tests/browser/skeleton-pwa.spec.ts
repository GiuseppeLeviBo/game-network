import { expect, test } from "@playwright/test";

test("skeleton PWA exchanges guest input and host snapshots across pages", async ({ browser }) => {
  const context = await browser.newContext();
  const host = await context.newPage();
  const guest = await context.newPage();
  const room = `ROOM-${Date.now()}`;

  await host.goto(`/?role=host&room=${room}&name=HST&peer=host-peer`);
  await expect(host.getByTestId("status")).toHaveText("Hosting");

  await guest.goto(`/?role=guest&room=${room}&name=GST&peer=guest-peer&host=host-peer`);
  await expect(guest.getByTestId("status")).toHaveText("Connected");
  await expect(guest.getByTestId("local-player")).toContainText("p2 GST");
  await expect(host.getByTestId("players")).toContainText("GST");

  await guest.getByTestId("send-input").click();

  await expect(host.getByTestId("last-input")).toContainText("p2:pulse");
  await expect(guest.getByTestId("last-snapshot")).toHaveText("p2:1");

  await context.close();
});
