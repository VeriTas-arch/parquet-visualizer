import * as vscode from 'vscode';

const VIEW_TYPE = 'parquet-visualizer.preview';
const DEFAULT_PREVIEW_ROWS = 500;
const MIN_PREVIEW_ROWS = 1;
const MAX_PREVIEW_ROWS = 10000;
const MAX_CELL_LENGTH = 180;

class ParquetDocument implements vscode.CustomDocument {
	constructor(public readonly uri: vscode.Uri) {}

	dispose(): void {}
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
	const provider = new ParquetPreviewProvider();

	context.subscriptions.push(
		vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
			supportsMultipleEditorsPerDocument: false,
		})
	);
}

export function deactivate(): void {}

class ParquetPreviewProvider implements vscode.CustomReadonlyEditorProvider<ParquetDocument> {
	openCustomDocument(uri: vscode.Uri): ParquetDocument {
		return new ParquetDocument(uri);
	}

	async resolveCustomEditor(document: ParquetDocument, webviewPanel: vscode.WebviewPanel): Promise<void> {
		webviewPanel.webview.options = {
			enableScripts: false,
		};
		webviewPanel.webview.html = renderLoadingHtml(webviewPanel.webview, document.uri);

		try {
			const preview = await readPreview(document.uri);
			webviewPanel.webview.html = renderPreviewHtml(webviewPanel.webview, preview);
		} catch (error) {
			webviewPanel.webview.html = renderErrorHtml(webviewPanel.webview, document.uri, error);
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
	};
}

function getMaxPreviewRows(uri: vscode.Uri): number {
	const value = vscode.workspace
		.getConfiguration('simpleParquetVisualizer', uri)
		.get<number>('maxPreviewRows', DEFAULT_PREVIEW_ROWS);

	if (!Number.isInteger(value)) {
		return DEFAULT_PREVIEW_ROWS;
	}

	return Math.min(MAX_PREVIEW_ROWS, Math.max(MIN_PREVIEW_ROWS, value));
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

function renderPreviewHtml(webview: vscode.Webview, preview: PreviewData): string {
	const styles = baseStyles(webview);
	const visibleRows = preview.rows.length;
	const subtitle = BigInt(visibleRows) === preview.totalRows
		? `${visibleRows.toLocaleString()} rows`
		: `Showing first ${visibleRows.toLocaleString()} of ${formatBigInt(preview.totalRows)} rows`;

	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>${escapeHtml(preview.fileName)}</title>
	<style>${styles}</style>
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
</body>
</html>`;
}

function renderLoadingHtml(webview: vscode.Webview, uri: vscode.Uri): string {
	return renderMessageHtml(webview, getFileName(uri), 'Reading Parquet metadata and preview rows...');
}

function renderErrorHtml(webview: vscode.Webview, uri: vscode.Uri, error: unknown): string {
	return renderMessageHtml(webview, getFileName(uri), error instanceof Error ? error.message : String(error), true);
}

function renderMessageHtml(webview: vscode.Webview, title: string, message: string, isError = false): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>${escapeHtml(title)}</title>
	<style>${baseStyles(webview)}</style>
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

	const headers = preview.columns.map(column => `<th><span>${escapeHtml(column.name)}</span><small>${escapeHtml(column.type)}</small></th>`).join('');
	const body = preview.rows.map((row, index) => {
		const cells = preview.columns.map(column => `<td>${formatCell(row[column.name])}</td>`).join('');
		return `<tr><th class="row-index">${(index + 1).toLocaleString()}</th>${cells}</tr>`;
	}).join('');

	return `<table>
	<thead><tr><th class="row-index">#</th>${headers}</tr></thead>
	<tbody>${body}</tbody>
</table>`;
}

function formatCell(value: unknown): string {
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
	return escapeHtml(truncate(text));
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

function truncate(value: string): string {
	if (value.length <= MAX_CELL_LENGTH) {
		return value;
	}

	return `${value.slice(0, MAX_CELL_LENGTH - 3)}...`;
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

function baseStyles(webview: vscode.Webview): string {
	void webview;
	return `
:root {
	color-scheme: light dark;
}

body {
	margin: 0;
	background: var(--vscode-editor-background);
	color: var(--vscode-editor-foreground);
	font-family: var(--vscode-font-family);
	font-size: var(--vscode-font-size);
}

.summary {
	display: flex;
	gap: 24px;
	justify-content: space-between;
	align-items: flex-start;
	padding: 18px 22px 14px;
	border-bottom: 1px solid var(--vscode-panel-border);
	background: var(--vscode-editor-background);
}

h1 {
	margin: 0 0 6px;
	font-size: 18px;
	font-weight: 600;
}

p {
	margin: 0;
	color: var(--vscode-descriptionForeground);
}

.stats {
	display: grid;
	grid-template-columns: repeat(4, minmax(88px, auto));
	gap: 10px;
}

.stat {
	padding: 7px 10px;
	border: 1px solid var(--vscode-panel-border);
	border-radius: 6px;
	background: var(--vscode-sideBar-background);
}

.stat span,
.schema-col span,
th small {
	display: block;
	color: var(--vscode-descriptionForeground);
	font-size: 11px;
	line-height: 1.35;
}

.stat strong {
	display: block;
	margin-top: 2px;
	font-size: 13px;
	font-weight: 600;
	white-space: nowrap;
}

.schema {
	display: flex;
	gap: 8px;
	overflow-x: auto;
	padding: 12px 22px;
	border-bottom: 1px solid var(--vscode-panel-border);
	background: var(--vscode-editor-background);
}

.schema-col {
	min-width: 132px;
	max-width: 220px;
	padding: 7px 9px;
	border: 1px solid var(--vscode-panel-border);
	border-radius: 6px;
	background: var(--vscode-sideBar-background);
}

.schema-col strong {
	display: block;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	font-weight: 600;
}

.table-wrap {
	overflow: auto;
}

table {
	border-collapse: separate;
	border-spacing: 0;
	min-width: 100%;
}

th,
td {
	max-width: 360px;
	padding: 7px 10px;
	border-right: 1px solid var(--vscode-panel-border);
	border-bottom: 1px solid var(--vscode-panel-border);
	text-align: left;
	vertical-align: top;
	white-space: nowrap;
}

td {
	overflow: hidden;
	text-overflow: ellipsis;
	font-family: var(--vscode-editor-font-family);
	font-size: var(--vscode-editor-font-size);
}

thead th {
	position: sticky;
	top: 0;
	z-index: 2;
	background: var(--vscode-sideBar-background);
	font-weight: 600;
}

thead th span {
	display: block;
	max-width: 320px;
	overflow: hidden;
	text-overflow: ellipsis;
}

.row-index {
	position: sticky;
	left: 0;
	z-index: 1;
	width: 56px;
	min-width: 56px;
	max-width: 56px;
	background: var(--vscode-sideBar-background);
	color: var(--vscode-descriptionForeground);
	text-align: right;
}

thead .row-index {
	z-index: 4;
}

.null {
	color: var(--vscode-descriptionForeground);
	font-style: italic;
}

.empty,
.message {
	padding: 28px 22px;
}

.message.error p {
	color: var(--vscode-errorForeground);
}

@media (max-width: 720px) {
	.summary {
		display: block;
	}

	.stats {
		grid-template-columns: repeat(2, minmax(0, 1fr));
		margin-top: 14px;
	}
}
`;
}
