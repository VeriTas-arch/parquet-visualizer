(() => {
    const table = document.querySelector('table[data-resizable="true"]');
    if (!table) {
        return;
    }

    const tableWrap = table.closest('.table-wrap');
    const columns = Array.from(table.querySelectorAll('col[data-column-index]'));
    const defaultColumnWidth = readNumber(table.dataset.defaultColumnWidth, 180);
    const minColumnWidth = readNumber(table.dataset.minColumnWidth, 80);
    const maxColumnWidth = readNumber(table.dataset.maxColumnWidth, 640);
    const rowIndexWidth = readNumber(table.dataset.rowIndexWidth, 56);
    let active = null;

    function readNumber(value, fallback) {
        const parsed = Number.parseFloat(value || '');
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    function columnWidth(column) {
        return Number.parseFloat(column.style.width) || defaultColumnWidth;
    }

    function measuredColumnWidth(index) {
        const header = table.querySelector('th[data-column-index="' + index + '"]');
        const cells = Array.from(table.querySelectorAll('tbody tr > td:nth-child(' + (index + 2) + ')'));
        let width = minColumnWidth;

        if (header) {
            const title = header.querySelector('.column-title');
            const type = header.querySelector('small');
            width = Math.max(
                width,
                title ? title.scrollWidth + 36 : 0,
                type ? type.scrollWidth + 36 : 0
            );
        }

        for (const cell of cells) {
            width = Math.max(width, cell.scrollWidth + 2);
        }

        return Math.min(maxColumnWidth, Math.max(minColumnWidth, Math.ceil(width)));
    }

    function fitInitialColumnWidths() {
        columns.forEach((column, index) => {
            column.style.width = measuredColumnWidth(index) + 'px';
        });
        updateTableWidth();
    }

    function updateTableWidth() {
        const dataWidth = columns.reduce((total, column) => total + columnWidth(column), 0);
        table.style.width = (rowIndexWidth + dataWidth) + 'px';
    }

    function resize(event) {
        if (!active) {
            return;
        }

        const width = Math.min(maxColumnWidth, Math.max(minColumnWidth, active.startWidth + event.clientX - active.startX));
        active.column.style.width = width + 'px';
        updateTableWidth();
    }

    function stop(event) {
        if (!active) {
            return;
        }

        active.handle.releasePointerCapture(event.pointerId);
        active.handle.classList.remove('is-active');
        document.body.classList.remove('is-resizing');
        active = null;
    }

    for (const handle of table.querySelectorAll('.resize-handle')) {
        handle.addEventListener('pointerdown', event => {
            const header = handle.closest('th[data-column-index]');
            if (!header) {
                return;
            }

            const column = columns[Number(header.dataset.columnIndex)];
            if (!column) {
                return;
            }

            active = {
                column,
                handle,
                startX: event.clientX,
                startWidth: columnWidth(column),
            };
            handle.setPointerCapture(event.pointerId);
            handle.classList.add('is-active');
            document.body.classList.add('is-resizing');
            event.preventDefault();
        });
        handle.addEventListener('pointermove', resize);
        handle.addEventListener('pointerup', stop);
        handle.addEventListener('pointercancel', stop);
    }

    if (tableWrap) {
        tableWrap.addEventListener('wheel', event => {
            if (!event.ctrlKey) {
                return;
            }

            const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
            tableWrap.scrollLeft += delta;
            event.preventDefault();
        }, { passive: false });
    }

    fitInitialColumnWidths();
})();
