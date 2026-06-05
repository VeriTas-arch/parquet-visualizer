# Parquet Visualizer

Preview local `.parquet` files inside VS Code.

## Features

- Opens `.parquet` files with a read-only table preview by default.
- Shows file size, total rows, column count, row group count, and schema chips.
- Reads only the first 500 rows for a fast, compact preview.
- Uses a dependency-free Parquet parser package and no webview framework.

## Usage

Open a `.parquet` file from the Explorer. The extension manages the default open behavior and shows the read-only preview directly.

## Development

Run `npm run compile` when you want to rebuild the extension output. F5 does not run compilation automatically.

Run `npm run samples` to generate synthetic Parquet files under `samples/` for local preview testing. The default F5 launch opens `samples/preview.parquet`; generate the samples once before using that launch target in a fresh checkout.

## Limitations

- Only local file URIs are supported.
- The preview is read-only.
- The built-in parser supports uncompressed and Snappy-compressed Parquet files. Other codecs may fail to open.
