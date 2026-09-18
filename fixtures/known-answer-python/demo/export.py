"""Row export. Exported rows never carry the content field."""


def export_rows(rows):
    return [{k: v for k, v in row.items() if k != "content"} for row in rows]
