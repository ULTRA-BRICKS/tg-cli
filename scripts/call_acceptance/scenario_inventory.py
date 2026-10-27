"""Required #761 acceptance scenarios, independent of unittest discovery.

Deleting or renaming one requires a reviewed inventory/traceability change; a green
helper-only or reduced suite cannot satisfy the call acceptance manifest.
"""
REQUIRED_SCENARIOS = (
    'test_i01_quick_intro_exact_mirror_effect_order_and_same_anchor_edit',
    'test_i01b_human_frontdoor_output_never_claims_listening',
    'test_i02_raw_audio_gets_spoken_prefix_before_the_audio_and_provided_transcript_unverified',
    'test_i02b_raw_audio_without_transcript_is_honestly_unknown',
    'test_i02c_the_prefix_detector_fails_when_the_order_is_wrong',
    'test_i03_long_source_is_split_into_ordered_speech_segments_with_per_segment_metrics',
    'test_i04_long_astral_transcript_is_mirrored_in_utf16_bounded_ordered_chunks',
    'test_i05_every_reference_caller_recipient_and_timestamps_are_persisted_per_frontdoor',
    'test_i05b_kind_connectors_and_unknown_context_are_spoken_honestly',
    'test_i05c_caller_account_rings_the_owner_for_me_and_mirrors_into_the_owner_private_chat',
    'test_i06_both_frontdoors_share_store_identity_and_every_history_filter',
    'test_i06b_history_is_offline_read_only_and_never_creates_state',
    'test_i07_hostile_text_stays_literal_and_travels_over_private_stdin_not_argv',
    'test_i07b_flag_like_text_is_a_usage_error_before_any_sidecar',
    'test_i08_mirror_failures_and_wrong_chat_never_reach_tts_or_dial',
    'test_i09_final_edit_failure_is_a_warning_and_keeps_the_real_outcome',
    'test_i10_wrong_or_unverified_peer_and_identity_fail_closed_before_any_message',
    'test_i10b_copied_session_requires_idle_confirmation_before_any_network',
    'test_i11_timeout_declined_and_cancellation_are_terminal_single_attempts',
    'test_i12_idempotency_token_claims_one_attempt_forever_even_after_failure',
    'test_i13_missing_or_unconfirmed_provider_never_falls_back_to_host_speech_or_dials',
    'test_i14_each_segment_records_real_metrics_and_unmeasured_values_stay_null',
    'test_i15_completed_segment_metrics_survive_a_later_segment_failure_and_nothing_dials',
    'test_i16_dry_run_has_zero_network_tts_auth_reads_and_call_state_writes',
    'test_i17_private_modes_for_journal_audio_and_directories',
    'test_i18_live_two_way_conversation_is_rejected_before_any_provider_or_connection_effect',
    'test_i19_query_commands_do_not_read_an_open_inherited_stdin',
    'test_i19b_lab_commands_close_stdin_so_a_harness_with_an_open_pipe_cannot_hang',
    'test_i19c_a_hung_lab_command_is_ended_with_its_whole_process_group',
    'test_i19d_stdin_payload_commands_still_receive_their_input',
    'test_i20_history_reads_leave_existing_journal_logically_and_physically_unchanged',
)

REQUIRED_MUTATIONS = (
    'wrong-chat-accepted', 'mirror-failure-ignored', 'raw-audio-prefix-swapped',
    'parse-mode-not-literal', 'token-not-enforced', 'dial-retried',
    'anchor-not-edited', 'required-scenario-deleted',
)

# A nonzero exit alone can be an unrelated environmental failure, not a detector.
MUTATION_EXPECTED_IDS = {
    'wrong-chat-accepted': ('I08',),
    'mirror-failure-ignored': ('I08',),
    'raw-audio-prefix-swapped': ('I02',),
    'parse-mode-not-literal': ('I01',),
    'token-not-enforced': ('I12',),
    'dial-retried': ('I11',),
    'anchor-not-edited': ('I01',),
    'required-scenario-deleted': ('I01',),
}

# These approved scenarios exercise boundaries or detectors rather than the complete call path.
REGRESSION_SCENARIO_IDS = frozenset(('I02C', 'I18', 'I19', 'I19B', 'I19C'))
