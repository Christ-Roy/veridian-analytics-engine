#!/usr/bin/env python3
"""Contrat anti-régression de la rétention des logs ClickHouse staging."""

from pathlib import Path
import re
import xml.etree.ElementTree as ET


JOB = Path("deploy/analytics-engine-staging.nomad.hcl")
LOG_TABLES = {
    "asynchronous_metric_log",
    "error_log",
    "metric_log",
    "part_log",
    "processors_profile_log",
    "query_log",
    "query_views_log",
    "text_log",
    "trace_log",
}
TTL = "event_date + INTERVAL 7 DAY"


text = JOB.read_text(encoding="utf-8")

xml_match = re.search(
    r"<<CLICKHOUSE_SYSTEM_LOGS_XML\n(.*?)\nCLICKHOUSE_SYSTEM_LOGS_XML",
    text,
    flags=re.DOTALL,
)
assert xml_match, "fragment XML de rétention ClickHouse absent"
root = ET.fromstring(xml_match.group(1))
assert root.tag == "clickhouse", "racine XML ClickHouse invalide"

logger = root.find("logger")
assert logger is not None, "plafond des fichiers serveur absent"
assert logger.findtext("level") == "information", "logger staging trop verbeux"
assert logger.findtext("size") == "100M", "rotation fichier non bornée à 100M"
assert logger.findtext("count") == "3", "rotation fichier non bornée à 3 fichiers"

configured_logs = {child.tag for child in root if child.find("ttl") is not None}
assert configured_logs == LOG_TABLES, (
    f"allowlist TTL inattendue: {sorted(configured_logs)} != {sorted(LOG_TABLES)}"
)
for table in LOG_TABLES:
    assert root.findtext(f"{table}/ttl") == TTL, f"TTL 7 jours absent: {table}"

assert root.findtext("text_log/level") == "information", "text_log encore en trace"
assert root.findtext("metric_log/collect_interval_milliseconds") == "5000", (
    "metric_log doit être échantillonné toutes les 5 secondes"
)

assert "local/clickhouse-system-logs.xml:/etc/clickhouse-server/config.d/system-logs.xml:ro" in text, (
    "fragment ClickHouse non monté en lecture seule"
)
assert 'task "clickhouse-log-retention"' in text, "rattrapage TTL des tables existantes absent"
assert 'hook    = "poststart"' in text, "rattrapage TTL non exécuté après ClickHouse"

allowlist_match = re.search(r"for base in ([a-z_ ]+); do", text)
assert allowlist_match, "allowlist shell du rattrapage absente"
runtime_allowlist = set(allowlist_match.group(1).split())
assert runtime_allowlist == LOG_TABLES, (
    f"allowlist runtime inattendue: {sorted(runtime_allowlist)} != {sorted(LOG_TABLES)}"
)

for forbidden in ("DELETE FROM", "TRUNCATE TABLE", "DROP TABLE", "MATERIALIZE TTL"):
    assert forbidden not in text.upper(), f"mutation destructive interdite: {forbidden}"

assert f"MODIFY TTL {TTL}" in text, "rattrapage limité à MODIFY TTL absent"

print("OK ClickHouse staging logs: TTL 7j, verbosité et allowlist bornées")
