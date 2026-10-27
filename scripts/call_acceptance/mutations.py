"""Mutation detector evidence shared by the batch and manifest report consumer.

Reached by verify-calls and its synthetic controls. Only approved scenario IDs and
fixed result codes cross this boundary; unrelated failures must never kill a mutant.
"""
import json
import re

from .report import Check
from .scenario_inventory import MUTATION_EXPECTED_IDS, REQUIRED_MUTATIONS

PREFIX = 'MUTATION_RESULT '


def matches_expected(name, observed):
    expected = set(MUTATION_EXPECTED_IDS.get(name, ()))
    if name == 'required-scenario-deleted':
        return set(observed) == expected
    return bool(expected) and expected <= set(observed)


def scenario_ids(names):
    return sorted({f'I{match.group(1).upper()}' for name in names
                   if (match := re.match(r'^test_i(\d+[a-z]?)_', name))})


def detector_result(name, report, outcome):
    expected = list(MUTATION_EXPECTED_IDS.get(name, ()))
    record = {'name': name, 'status': 'fail', 'expected_failed_ids': expected,
              'observed_failed_ids': [], 'error_ids': [], 'reason': 'detector_inconclusive'}
    if outcome.timed_out or outcome.error or outcome.truncated:
        return record
    checks = report.get('checks', [])
    integration = next((c for c in checks if c.get('id') == 'hermetic.integration.integration'), {})
    evidence = integration.get('evidence', {})
    if name == 'baseline':
        if (outcome.code == 0 and report.get('summary', {}).get('overall') == 'pass'
                and integration.get('status') == 'pass'):
            record.update(status='pass', reason='baseline_passed')
        return record
    missing_inventory = name == 'required-scenario-deleted'
    observed = (scenario_ids(evidence.get('missing', [])) if missing_inventory
                else evidence.get('assertion_failed_ids', []))
    errors = evidence.get('error_ids', [])
    record.update(observed_failed_ids=observed, error_ids=errors)
    reason = 'required_scenarios_missing' if missing_inventory else 'tests_failed'
    if (outcome.code == 1 and report.get('summary', {}).get('overall') == 'fail'
            and integration.get('detail') == reason and expected and not errors
            and matches_expected(name, observed)):
        record.update(status='pass', reason=reason if missing_inventory else 'intended_assertion_failed')
    return record


def collect_results(text, sink):
    """Validate every named signal independently of the aggregate stdout summary."""
    records, malformed = parse_records(text)
    complete = not malformed and set(records) == {'baseline', *REQUIRED_MUTATIONS}
    for name in ('baseline', *REQUIRED_MUTATIONS):
        row = records.get(name, {})
        item = result_check(name, row)
        sink.append(item)
        complete = complete and item.status == "pass"
    return complete


def parse_records(text):
    records = {}
    malformed = False
    for line in text.splitlines():
        if not line.startswith(PREFIX):
            continue
        try:
            row = json.loads(line[len(PREFIX):])
            name = row['name']
            if name in records or name not in ('baseline', *REQUIRED_MUTATIONS):
                malformed = True
            records[name] = row
        except (ValueError, TypeError, KeyError):
            malformed = True
    return records, malformed


def result_check(name, row):
    expected = list(MUTATION_EXPECTED_IDS.get(name, ()))
    observed, errors = row.get('observed_failed_ids'), row.get('error_ids')
    valid_ids = (isinstance(observed, list) and all(isinstance(i, str) and re.fullmatch(r'I\d+[A-Z]?', i) for i in observed))
    reason = ('baseline_passed' if name == 'baseline' else
              'required_scenarios_missing' if name == 'required-scenario-deleted' else 'intended_assertion_failed')
    valid = (row.get('status') == 'pass' and row.get('expected_failed_ids') == expected
             and valid_ids and errors == [] and row.get('reason') == reason
             and (observed == [] if name == 'baseline' else matches_expected(name, observed)))
    item = Check(f'hermetic.mutation.{name}', f'mutation detector {name}', 'hermetic', 'fixture')
    item.settle('pass' if valid else 'fail', reason if valid else 'mutation_signal_missing_or_invalid',
                label='mutation', name=name, expected_failed_ids=expected,
                observed_failed_ids=observed if valid_ids else [], error_ids=errors if isinstance(errors, list) else [])
    return item
