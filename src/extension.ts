import * as vscode from 'vscode';

// Stable custom editor id. Must match package.json contributes.customEditors.viewType.
const VIEW_TYPE = 'parquet-visualizer.preview';
// User-facing setting defaults.
const DEFAULT_PREVIEW_ROWS = 500;
const DEFAULT_MAX_CELL_LENGTH = 180;
const DEFAULT_MAX_COLUMN_WIDTH = 640;
// Internal bounds for user-facing settings.
const MIN_PREVIEW_ROWS = 1;
const MAX_PREVIEW_ROWS = 10000;
const MIN_CELL_LENGTH = 40;
const MAX_CONFIGURABLE_CELL_LENGTH = 2000;
const MIN_COLUMN_WIDTH = 80;
const MAX_CONFIGURABLE_COLUMN_WIDTH = 2000;
// UI layout constants that are not exposed as settings.
const DEFAULT_COLUMN_WIDTH = 180;
const ROW_INDEX_WIDTH = 56;

class ParquetDocument implements vscode.CustomDocument {
    constructor(public readonly uri: vscode.Uri) { }

    dispose(): void { }
}

interface PreviewColumn {
    name: string;
    type: string;
}

interface PreviewData {
    fileName: string;
    fileSize: number;
    totalRows: bigint;
    rowGroups: number;
    columns: PreviewColumn[];
    rows: Record<string, unknown>[];
    maxColumnWidth: number;
    maxCellLength: number;
}

interface ParquetMetadataSummary {
    num_rows: bigint;
    row_groups: unknown[];
}

interface SchemaNode {
    children: SchemaNode[];
    element: {
        name: string;
        type?: string;
        converted_type?: string;
        logical_type?: LogicalTypeSummary;
    };
}

interface LogicalTypeSummary {
    type: string;
    precision?: number;
    scale?: number;
    unit?: string;
    bitWidth?: number;
    isSigned?: boolean;
}

export function activate(context: vscode.ExtensionContext): void {
    const provider = new ParquetPreviewProvider(context.extensionUri);

    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
            supportsMultipleEditorsPerDocument: false,
        })
    );
}

export function deactivate(): void { }

class ParquetPreviewProvider implements vscode.CustomReadonlyEditorProvider<ParquetDocument> {
    constructor(private readonly extensionUri: vscode.Uri) { }

    openCustomDocument(uri: vscode.Uri): ParquetDocument {
        return new ParquetDocument(uri);
    }

    async resolveCustomEditor(document: ParquetDocument, webviewPanel: vscode.WebviewPanel): Promise<void> {
        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.extensionUri, 'media'),
            ],
        };
        webviewPanel.webview.html = renderLoadingHtml(webviewPanel.webview, this.extensionUri, document.uri);

        try {
            const preview = await readPreview(document.uri);
            webviewPanel.webview.html = renderPreviewHtml(webviewPanel.webview, this.extensionUri, preview);
        } catch (error) {
            webviewPanel.webview.html = renderErrorHtml(webviewPanel.webview, this.extensionUri, document.uri, error);
        }
    }
}

async function readPreview(uri: vscode.Uri): Promise<PreviewData> {
    if (uri.scheme !== 'file') {
        throw new Error('Only local Parquet files are supported.');
    }

    const [{ asyncBufferFromFile, parquetMetadataAsync, parquetReadObjects, parquetSchema }, stat] = await Promise.all([
        import('hyparquet'),
        vscode.workspace.fs.stat(uri),
    ]);
    const file = await asyncBufferFromFile(uri.fsPath);
    const metadata = await parquetMetadataAsync(file);
    const schema = parquetSchema(metadata);
    const rowEnd = previewRowCount(metadata, getMaxPreviewRows(uri));
    const rows = rowEnd === 0 ? [] : await parquetReadObjects({
        file,
        metadata,
        rowStart: 0,
        rowEnd,
    });

    return {
        fileName: getFileName(uri),
        fileSize: stat.size,
        totalRows: metadata.num_rows,
        rowGroups: metadata.row_groups.length,
        columns: previewColumns(schema, rows),
        rows,
        maxColumnWidth: getMaxColumnWidth(uri),
        maxCellLength: getMaxCellLength(uri),
    };
}

function getMaxPreviewRows(uri: vscode.Uri): number {
    return getIntegerSetting(uri, 'maxPreviewRows', DEFAULT_PREVIEW_ROWS, MIN_PREVIEW_ROWS, MAX_PREVIEW_ROWS);
}

function getMaxColumnWidth(uri: vscode.Uri): number {
    return getIntegerSetting(uri, 'maxColumnWidth', DEFAULT_MAX_COLUMN_WIDTH, MIN_COLUMN_WIDTH, MAX_CONFIGURABLE_COLUMN_WIDTH);
}

function getMaxCellLength(uri: vscode.Uri): number {
    return getIntegerSetting(uri, 'maxCellLength', DEFAULT_MAX_CELL_LENGTH, MIN_CELL_LENGTH, MAX_CONFIGURABLE_CELL_LENGTH);
}

function getIntegerSetting(uri: vscode.Uri, key: string, fallback: number, min: number, max: number): number {
    const value = vscode.workspace
        .getConfiguration('simpleParquetVisualizer', uri)
        .get<number>(key, fallback);

    if (!Number.isInteger(value)) {
        return fallback;
    }

    return Math.min(max, Math.max(min, value));
}

function previewRowCount(metadata: ParquetMetadataSummary, maxPreviewRows: number): number {
    const limit = BigInt(maxPreviewRows);
    return Number(metadata.num_rows > limit ? limit : metadata.num_rows);
}

function previewColumns(schema: SchemaNode, rows: Record<string, unknown>[]): PreviewColumn[] {
    const columns = schema.children.map(child => ({
        name: child.element.name,
        type: columnType(child),
    }));
    const knownNames = new Set(columns.map(column => column.name));

    for (const row of rows) {
        for (const name of Object.keys(row)) {
            if (!knownNames.has(name)) {
                columns.push({ name, type: 'UNKNOWN' });
                knownNames.add(name);
            }
        }
    }

    return columns;
}

function columnType(column: SchemaNode): string {
    const element = column.element;

    if (element.logical_type) {
        const logical = element.logical_type;
        if (logical.type === 'DECIMAL' && logical.precision !== undefined && logical.scale !== undefined) {
            return `DECIMAL(${logical.precision}, ${logical.scale})`;
        }
        if ((logical.type === 'TIME' || logical.type === 'TIMESTAMP') && logical.unit !== undefined) {
            return `${logical.type}(${logical.unit})`;
        }
        if (logical.type === 'INTEGER' && logical.bitWidth !== undefined) {
            return `${logical.isSigned ? 'INT' : 'UINT'}${logical.bitWidth}`;
        }
        return logical.type;
    }

    if (element.converted_type) {
        return element.converted_type;
    }

    return element.type ?? 'GROUP';
}

function renderPreviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, preview: PreviewData): string {
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'preview.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'preview.js'));
    const visibleRows = preview.rows.length;
    const subtitle = BigInt(visibleRows) === preview.totalRows
        ? `${visibleRows.toLocaleString()} rows`
        : `Showing first ${visibleRows.toLocaleString()} of ${formatBigInt(preview.totalRows)} rows`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource};">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>${escapeHtml(preview.fileName)}</title>
	<link rel="stylesheet" href="${styleUri}">
</head>
<body>
	<header class="summary">
		<div>
			<h1>${escapeHtml(preview.fileName)}</h1>
			<p>${escapeHtml(subtitle)}</p>
		</div>
		<div class="stats">
			${renderStat('Rows', formatBigInt(preview.totalRows))}
			${renderStat('Columns', preview.columns.length.toLocaleString())}
			${renderStat('Row groups', preview.rowGroups.toLocaleString())}
			${renderStat('Size', formatBytes(preview.fileSize))}
		</div>
	</header>
	<section class="schema">
		${preview.columns.map(renderSchemaColumn).join('')}
	</section>
	<main class="table-wrap">
		${renderTable(preview)}
	</main>
	<script src="${scriptUri}"></script>
</body>
</html>`;
}

function renderLoadingHtml(webview: vscode.Webview, extensionUri: vscode.Uri, uri: vscode.Uri): string {
    return renderMessageHtml(webview, extensionUri, getFileName(uri), 'Reading Parquet metadata and preview rows...');
}

function renderErrorHtml(webview: vscode.Webview, extensionUri: vscode.Uri, uri: vscode.Uri, error: unknown): string {
    return renderMessageHtml(webview, extensionUri, getFileName(uri), error instanceof Error ? error.message : String(error), true);
}

function renderMessageHtml(webview: vscode.Webview, extensionUri: vscode.Uri, title: string, message: string, isError = false): string {
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'preview.css'));

    return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource};">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>${escapeHtml(title)}</title>
	<link rel="stylesheet" href="${styleUri}">
</head>
<body>
	<div class="message ${isError ? 'error' : ''}">
		<h1>${escapeHtml(title)}</h1>
		<p>${escapeHtml(message)}</p>
	</div>
</body>
</html>`;
}

function renderStat(label: string, value: string): string {
    return `<div class="stat"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function renderSchemaColumn(column: PreviewColumn): string {
    return `<div class="schema-col"><strong>${escapeHtml(column.name)}</strong><span>${escapeHtml(column.type)}</span></div>`;
}

function renderTable(preview: PreviewData): string {
    if (preview.rows.length === 0) {
        return '<div class="empty">This file has no rows to preview.</div>';
    }

    const tableWidth = ROW_INDEX_WIDTH + preview.columns.length * DEFAULT_COLUMN_WIDTH;
    const colgroup = `<colgroup><col class="row-index-col" style="width: ${ROW_INDEX_WIDTH}px;">${preview.columns.map((_, index) => `<col data-column-index="${index}" style="width: ${DEFAULT_COLUMN_WIDTH}px;">`).join('')}</colgroup>`;
    const headers = preview.columns.map((column, index) => `<th data-column-index="${index}"><span class="column-title">${escapeHtml(column.name)}</span><small>${escapeHtml(column.type)}</small><span class="resize-handle" role="separator" aria-label="Resize ${escapeHtml(column.name)} column"></span></th>`).join('');
    const body = preview.rows.map((row, index) => {
        const cells = preview.columns.map(column => `<td>${formatCell(row[column.name], preview.maxCellLength)}</td>`).join('');
        return `<tr><th class="row-index">${(index + 1).toLocaleString()}</th>${cells}</tr>`;
    }).join('');

    return `<table data-resizable="true" data-default-column-width="${DEFAULT_COLUMN_WIDTH}" data-min-column-width="${MIN_COLUMN_WIDTH}" data-max-column-width="${preview.maxColumnWidth}" data-row-index-width="${ROW_INDEX_WIDTH}" style="width: ${tableWidth}px;">
	${colgroup}
	<thead><tr><th class="row-index">#</th>${headers}</tr></thead>
	<tbody>${body}</tbody>
</table>`;
}

function formatCell(value: unknown, maxCellLength: number): string {
    if (value === null) {
        return '<span class="null">null</span>';
    }
    if (value === undefined) {
        return '<span class="null">undefined</span>';
    }
    if (typeof value === 'bigint') {
        return escapeHtml(value.toString());
    }
    if (value instanceof Uint8Array) {
        return escapeHtml(`bytes[${value.length}] ${Array.from(value.slice(0, 12)).map(byte => byte.toString(16).padStart(2, '0')).join(' ')}`);
    }
    if (value instanceof Date) {
        return escapeHtml(value.toISOString());
    }

    const text = typeof value === 'object' ? JSON.stringify(value, stringifyValue) : String(value);
    return escapeHtml(truncate(text, maxCellLength));
}

function stringifyValue(key: string, value: unknown): unknown {
    void key;
    if (typeof value === 'bigint') {
        return value.toString();
    }
    if (value instanceof Uint8Array) {
        return `bytes[${value.length}]`;
    }
    return value;
}

function truncate(value: string, maxCellLength: number): string {
    if (value.length <= maxCellLength) {
        return value;
    }

    return `${value.slice(0, maxCellLength - 3)}...`;
}

function formatBytes(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = bytes;
    let unit = 0;

    while (size >= 1024 && unit < units.length - 1) {
        size /= 1024;
        unit += 1;
    }

    return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatBigInt(value: bigint): string {
    return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function getFileName(uri: vscode.Uri): string {
    const parts = uri.fsPath.split(/[\\/]/);
    return parts[parts.length - 1] || uri.fsPath;
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
