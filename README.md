# ZotCloud for Zotero

ZotCloud synchronizes Zotero library data and attachments with a storage account chosen by the user. Version 0.1.0 includes providers for WebDAV, Google Drive, Dropbox, and pCloud.

## Features

The plugin records local changes, queues transfers, and keeps a cloud manifest for each configured connection. It can upload and download attachments, resume periodic synchronization, organize remote filenames from item metadata, and present conflicts for review. Provider credentials and synchronization settings remain in the local Zotero profile.

## Installation

Download `zotcloud-0.1.0.xpi` from the latest release. In Zotero, open `Tools > Plugins`, choose `Install Add-on From File`, and select the XPI. Configure a provider from the ZotCloud section of Zotero settings before starting the first synchronization.

Version 0.1.0 is an early release. Back up the Zotero data directory and test with a small library before using it on a main collection. The supported Zotero range is 7-9.

## Development

Install Node.js, clone the repository, and run `npm ci`. Run `npm test` for the Vitest suite and `npm run build` to create the XPI. The current tests cover UUID generation, debouncing, and conflict resolution.

## License

ZotCloud is released under the MIT License. See [LICENSE](LICENSE).
