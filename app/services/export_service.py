import csv
from collections import defaultdict
from collections.abc import Sequence
from decimal import Decimal
from io import BytesIO, StringIO

from openpyxl import Workbook
from openpyxl.cell.cell import ILLEGAL_CHARACTERS_RE
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.worksheet import Worksheet

from ..models import Transaction

HEADERS = ("Дата", "Тип", "Категория", "Описание", "Сумма")
AMOUNT_FORMAT = '#,##0.00;[Red]-#,##0.00;0.00'
HEADER_FILL = PatternFill("solid", fgColor="173D32")
TOTAL_FILL = PatternFill("solid", fgColor="E6F2DD")
TYPE_NAMES = {"income": "Доход", "expense": "Расход"}


def _signed_amount(row: Transaction) -> Decimal:
    amount = Decimal(str(row.amount))
    return amount if row.type == "income" else -amount


def _write_sheet(
    sheet: Worksheet, headers: tuple, rows, formats: dict[int, str], *, total: tuple | None = None,
) -> None:
    sheet.append(headers)
    sheet.freeze_panes = "A2"
    sheet.sheet_view.showGridLines = False
    sheet.row_dimensions[1].height = 24
    for cell in sheet[1]:
        cell.font = Font(color="FFFFFF", bold=True)
        cell.fill = HEADER_FILL
        cell.alignment = Alignment(vertical="center")

    widths = [len(title) for title in headers]
    for values in rows:
        values = tuple(ILLEGAL_CHARACTERS_RE.sub("", value) if isinstance(value, str) else value for value in values)
        sheet.append(values)
        for cell, value in zip(sheet[sheet.max_row], values, strict=True):
            if isinstance(value, str):
                cell.data_type = "s"
                if len(value) > 58 or "\n" in value:
                    cell.alignment = Alignment(wrap_text=True, vertical="top")
            if cell.column in formats:
                cell.number_format = formats[cell.column]
            width = 20 if hasattr(value, "isoformat") else max(
                (len(line) for line in str(value).splitlines()), default=0,
            )
            index = cell.column - 1
            widths[index] = max(widths[index], width)

    if sheet.max_row > 1:
        sheet.auto_filter.ref = sheet.dimensions
    if total is not None:
        sheet.append(total)
        sheet.row_dimensions[sheet.max_row].height = 22
        for cell in sheet[sheet.max_row]:
            cell.fill = TOTAL_FILL
            cell.font = Font(bold=True, color="173D32")
            if cell.column in formats:
                cell.number_format = formats[cell.column]
        widths[-1] = max(widths[-1], len(str(total[-1])))
    for index, width in enumerate(widths, start=1):
        sheet.column_dimensions[get_column_letter(index)].width = min(62, max(12, width + 4))


def build_excel(transactions: Sequence[Transaction]) -> BytesIO:
    categories = defaultdict(lambda: {"income": Decimal(0), "expense": Decimal(0)})
    months = defaultdict(lambda: {"income": Decimal(0), "expense": Decimal(0)})
    income = expense = Decimal(0)
    for row in transactions:
        amount = Decimal(str(row.amount))
        categories[row.category][row.type] += amount
        months[row.created_at.strftime("%Y-%m")][row.type] += amount
        if row.type == "income":
            income += amount
        else:
            expense += amount

    workbook = Workbook()
    operations = workbook.active
    operations.title = "Операции"
    _write_sheet(
        operations, HEADERS,
        ((row.created_at, TYPE_NAMES[row.type], row.category, row.description, _signed_amount(row))
         for row in transactions),
        {1: "dd.mm.yyyy hh:mm", 5: AMOUNT_FORMAT},
        total=("Итого (сальдо)", None, None, None, income - expense),
    )
    _write_sheet(
        workbook.create_sheet("По категориям"), ("Категория", "Расходы", "Доходы", "Доля в расходах %"),
        ((category, values["expense"], values["income"], values["expense"] / expense if expense else 0)
         for category, values in sorted(categories.items(), key=lambda pair: (-pair[1]["expense"], pair[0]))),
        {2: AMOUNT_FORMAT, 3: AMOUNT_FORMAT, 4: "0.0%"},
    )
    _write_sheet(
        workbook.create_sheet("По месяцам"), ("Месяц", "Доходы", "Расходы", "Сальдо"),
        ((month, values["income"], values["expense"], values["income"] - values["expense"])
         for month, values in sorted(months.items())),
        {2: AMOUNT_FORMAT, 3: AMOUNT_FORMAT, 4: AMOUNT_FORMAT},
    )
    output = BytesIO()
    workbook.save(output)
    output.seek(0)
    return output


def _csv_text(value: str) -> str:
    if value.startswith(("\t", "\r", "\n")) or value.lstrip().startswith(("=", "+", "-", "@")):
        return "'" + value
    return value


def build_csv(transactions: Sequence[Transaction]) -> BytesIO:
    output = StringIO(newline="")
    writer = csv.writer(output, delimiter=";")
    writer.writerow(HEADERS)
    for row in transactions:
        writer.writerow((
            row.created_at.strftime("%d.%m.%Y %H:%M:%S"), TYPE_NAMES[row.type],
            _csv_text(row.category), _csv_text(row.description),
            format(_signed_amount(row), "f").replace(".", ","),
        ))
    return BytesIO(output.getvalue().encode("utf-8-sig"))
