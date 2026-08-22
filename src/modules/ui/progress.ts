/**
 * Sync progress indicator.
 * Shows upload/download progress via Zotero's built-in progress window.
 */

let progressWindow: any = null;
let progressLine: any = null;

export function showProgress(message: string, percent: number): void {
  if (!progressWindow) {
    progressWindow = new Zotero.ProgressWindow({ closeOnClick: false });
    progressWindow.changeHeadline("ZotCloud Sync");
    progressLine = new progressWindow.ItemProgress(
      "chrome://zotcloud/content/icons/zotcloud-16.svg",
      message,
    );
    progressWindow.show();
  }

  if (progressLine) {
    progressLine.setText(message);
    progressLine.setProgress(percent);
  }

  if (percent >= 100) {
    setTimeout(() => hideProgress(), 2000);
  }
}

export function hideProgress(): void {
  if (progressWindow) {
    progressWindow.close();
    progressWindow = null;
    progressLine = null;
  }
}

export function showError(message: string): void {
  const pw = new Zotero.ProgressWindow();
  pw.changeHeadline("ZotCloud Error");
  pw.addDescription(message);
  pw.show();
  pw.startCloseTimer(5000);
}

export function showSuccess(message: string): void {
  const pw = new Zotero.ProgressWindow();
  pw.changeHeadline("ZotCloud");
  pw.addDescription(message);
  pw.show();
  pw.startCloseTimer(3000);
}
