import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parquetWriteBuffer } from 'hyparquet-writer';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SAMPLE_DIR = join(ROOT, 'samples');

const cases = [
	{
		fileName: 'preview.parquet',
		description: '600 rows with common scalar, timestamp, nullable, long text, and JSON columns',
		rows: makePreviewRows(),
		columns: [
			{ name: 'order_id', type: 'INT64' },
			{ name: 'customer', type: 'STRING' },
			{ name: 'amount', type: 'DOUBLE' },
			{ name: 'is_priority', type: 'BOOLEAN' },
			{ name: 'ordered_at', type: 'TIMESTAMP' },
			{ name: 'status', type: 'STRING' },
			{ name: 'note', type: 'STRING' },
			{ name: 'payload', type: 'JSON' },
		],
		rowGroupSize: [128, 256],
	},
	{
		fileName: 'small.parquet',
		description: 'short table that should render without truncation messaging',
		rows: makeSmallRows(),
		columns: [
			{ name: 'id', type: 'INT32' },
			{ name: 'name', type: 'STRING' },
			{ name: 'score', type: 'FLOAT' },
			{ name: 'active', type: 'BOOLEAN' },
		],
		rowGroupSize: 10,
	},
	{
		fileName: 'wide.parquet',
		description: 'wide table for horizontal scrolling and sticky row numbers',
		rows: makeWideRows(),
		columns: makeWideColumns(),
		rowGroupSize: 50,
	},
	{
		fileName: 'nulls-and-long-values.parquet',
		description: 'nullable cells and long values for cell rendering checks',
		rows: makeNullAndLongRows(),
		columns: [
			{ name: 'row_id', type: 'INT32' },
			{ name: 'nullable_text', type: 'STRING' },
			{ name: 'nullable_number', type: 'DOUBLE' },
			{ name: 'long_text', type: 'STRING' },
			{ name: 'details', type: 'JSON' },
		],
		rowGroupSize: 25,
	},
];

await mkdir(SAMPLE_DIR, { recursive: true });

for (const testCase of cases) {
	const output = join(SAMPLE_DIR, testCase.fileName);
	const buffer = parquetWriteBuffer({
		columnData: testCase.columns.map(column => ({
			...column,
			data: testCase.rows.map(row => row[column.name]),
		})),
		rowGroupSize: testCase.rowGroupSize,
		kvMetadata: [
			{ key: 'created_by', value: 'parquet-visualizer sample generator' },
			{ key: 'description', value: testCase.description },
		],
	});

	await writeFile(output, Buffer.from(buffer));
	console.log(`Generated ${output}`);
}

function makePreviewRows() {
	return Array.from({ length: 600 }, (_, index) => {
		const orderNumber = index + 1;
		const status = ['new', 'processing', 'shipped', 'returned'][index % 4];

		return {
			order_id: BigInt(1000000 + orderNumber),
			customer: `Customer ${String(orderNumber).padStart(3, '0')}`,
			amount: Number((19.95 + (index % 37) * 3.42).toFixed(2)),
			is_priority: index % 9 === 0,
			ordered_at: new Date(Date.UTC(2026, 0, 1, 8 + (index % 12), index % 60, 0)),
			status: index % 17 === 0 ? null : status,
			note: index % 23 === 0
				? 'Long note for preview truncation: '.repeat(12).trim()
				: `Batch ${Math.floor(index / 50) + 1}`,
			payload: {
				region: ['NA', 'EU', 'APAC'][index % 3],
				channel: ['web', 'retail', 'partner'][index % 3],
				items: 1 + (index % 5),
			},
		};
	});
}

function makeSmallRows() {
	return Array.from({ length: 12 }, (_, index) => ({
		id: index + 1,
		name: `Item ${index + 1}`,
		score: Number((0.25 + index * 0.075).toFixed(3)),
		active: index % 2 === 0,
	}));
}

function makeWideColumns() {
	return [
		{ name: 'row_id', type: 'INT32' },
		...Array.from({ length: 32 }, (_, index) => ({
			name: `metric_${String(index + 1).padStart(2, '0')}`,
			type: 'DOUBLE',
		})),
	];
}

function makeWideRows() {
	return Array.from({ length: 80 }, (_, rowIndex) => {
		const row = { row_id: rowIndex + 1 };

		for (let columnIndex = 1; columnIndex <= 32; columnIndex += 1) {
			row[`metric_${String(columnIndex).padStart(2, '0')}`] = Number(((rowIndex + 1) * columnIndex / 7).toFixed(4));
		}

		return row;
	});
}

function makeNullAndLongRows() {
	return Array.from({ length: 75 }, (_, index) => ({
		row_id: index + 1,
		nullable_text: index % 3 === 0 ? null : `value-${index + 1}`,
		nullable_number: index % 4 === 0 ? null : Number((index * 1.618).toFixed(3)),
		long_text: index % 5 === 0
			? `row-${index + 1} ` + 'This field is intentionally verbose so the preview can verify ellipsis behavior. '.repeat(8).trim()
			: `short-${index + 1}`,
		details: {
			group: index % 6,
			flags: {
				alpha: index % 2 === 0,
				beta: index % 5 === 0,
			},
		},
	}));
}
