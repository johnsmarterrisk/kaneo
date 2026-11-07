import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const saveAs = vi.hoisted(() => vi.fn());
vi.mock("file-saver", () => ({ saveAs }));

import { saveScriptFile } from "./save-script-file";

const args = {
  filename: "07 - Intro.txt",
  body: "Intro\n\nWear earplugs.",
  type: "text/plain;charset=utf-8",
};

function setPointer(coarse: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: coarse && query === "(pointer: coarse)",
    })),
  );
}

function setShare(
  share: ((data: ShareData) => Promise<void>) | undefined,
  canShare: ((data: ShareData) => boolean) | undefined,
) {
  Object.defineProperty(navigator, "share", {
    configurable: true,
    value: share,
  });
  Object.defineProperty(navigator, "canShare", {
    configurable: true,
    value: canShare,
  });
}

describe("saveScriptFile", () => {
  beforeEach(() => {
    saveAs.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    setShare(undefined, undefined);
  });

  it("downloads with saveAs on a fine pointer", async () => {
    setPointer(false);
    const share = vi.fn();
    setShare(share, () => true);

    await expect(saveScriptFile(args)).resolves.toBe("saved");

    expect(saveAs).toHaveBeenCalledTimes(1);
    const [blob, name] = saveAs.mock.calls[0];
    expect(name).toBe("07 - Intro.txt");
    expect((blob as Blob).type).toBe("text/plain;charset=utf-8");
    expect(await (blob as Blob).text()).toBe(args.body);
    expect(share).not.toHaveBeenCalled();
  });

  it("shares the file on a coarse pointer that can share files", async () => {
    setPointer(true);
    const share = vi.fn().mockResolvedValue(undefined);
    const canShare = vi.fn(() => true);
    setShare(share, canShare);

    await expect(saveScriptFile(args)).resolves.toBe("shared");

    const file = share.mock.calls[0][0].files[0] as File;
    expect(file.name).toBe("07 - Intro.txt");
    expect(file.type).toBe("text/plain;charset=utf-8");
    expect(await file.text()).toBe(args.body);
    expect(canShare).toHaveBeenCalledWith({ files: [file] });
    expect(saveAs).not.toHaveBeenCalled();
  });

  it("reports a cancelled share sheet as cancelled", async () => {
    setPointer(true);
    setShare(
      vi.fn().mockRejectedValue(new DOMException("no", "AbortError")),
      () => true,
    );
    await expect(saveScriptFile(args)).resolves.toBe("cancelled");
  });

  it("rethrows any other share rejection", async () => {
    setPointer(true);
    const failure = new DOMException("denied", "NotAllowedError");
    setShare(vi.fn().mockRejectedValue(failure), () => true);
    await expect(saveScriptFile(args)).rejects.toBe(failure);
  });

  it("is unavailable when the device cannot share files", async () => {
    setPointer(true);
    const share = vi.fn();
    setShare(share, () => false);
    await expect(saveScriptFile(args)).resolves.toBe("unavailable");
    expect(share).not.toHaveBeenCalled();
    expect(saveAs).not.toHaveBeenCalled();
  });

  it.each([
    ["share", { share: undefined, canShare: () => true }],
    ["canShare", { share: vi.fn(), canShare: undefined }],
  ])("is unavailable without navigator.%s", async (_name, api) => {
    setPointer(true);
    setShare(api.share, api.canShare);
    await expect(saveScriptFile(args)).resolves.toBe("unavailable");
    expect(saveAs).not.toHaveBeenCalled();
    expect(api.share ?? vi.fn()).not.toHaveBeenCalled();
  });

  it("is unavailable without File, and builds no file", async () => {
    setPointer(true);
    const share = vi.fn();
    const canShare = vi.fn(() => true);
    setShare(share, canShare);
    vi.stubGlobal("File", undefined);
    await expect(saveScriptFile(args)).resolves.toBe("unavailable");
    expect(canShare).not.toHaveBeenCalled();
    expect(share).not.toHaveBeenCalled();
    expect(saveAs).not.toHaveBeenCalled();
  });
});
