import pytest
from datetime import datetime, timedelta
from src.data_processor import DataProcessor


class TestDataProcessor:
    @pytest.fixture
    def data_processor_instance(self, tmp_path):
        config_file = tmp_path / "config.json"
        config_file.write_text("{}")
        return DataProcessor(str(config_file))

    def test_validate_user_input_with_valid_data(self, data_processor_instance):
        valid_user_data = {
            'user_id': 123,
            'email_address': 'test@example.com',
            'first_name': 'John',
            'last_name': 'Doe'
        }

        result = data_processor_instance.validate_user_input(valid_user_data)
        assert result is True

    def test_validate_user_input_with_missing_fields(self, data_processor_instance):
        invalid_user_data = {
            'user_id': 123,
            'email_address': 'test@example.com'
        }

        result = data_processor_instance.validate_user_input(invalid_user_data)
        assert result is False

    def test_calculate_average_score_with_valid_scores(self, data_processor_instance):
        score_list = [85.5, 90.0, 78.5, 92.0]
        expected_average = sum(score_list) / len(score_list)

        result = data_processor_instance.calculate_average_score(score_list)
        assert result == expected_average

    def test_calculate_average_score_with_empty_list(self, data_processor_instance):
        empty_score_list = []

        result = data_processor_instance.calculate_average_score(empty_score_list)
        assert result == 0.0

    def test_filter_active_users_returns_recent_users(self, data_processor_instance):
        recent_date = datetime.now() - timedelta(days=10)
        old_date = datetime.now() - timedelta(days=60)

        test_users = [
            {'user_id': 1, 'name': 'Active User', 'last_login_date': recent_date},
            {'user_id': 2, 'name': 'Inactive User', 'last_login_date': old_date}
        ]

        active_user_list = data_processor_instance.filter_active_users(test_users)
        assert len(active_user_list) == 1
        assert active_user_list[0]['user_id'] == 1

    def test_process_batch_records_handles_valid_records(self, data_processor_instance):
        valid_records = [
            {
                'user_id': 1,
                'email_address': 'user1@test.com',
                'first_name': 'Test',
                'last_name': 'User'
            }
        ]

        processing_result = data_processor_instance.process_batch_records(valid_records)

        assert processing_result['error_count'] == 0
        assert len(processing_result['processed_items']) == 1
        assert processing_result['success_rate'] == 100.0

    def test_process_batch_records_handles_invalid_records(self, data_processor_instance):
        invalid_records = [
            {'user_id': 1, 'email_address': 'incomplete@test.com'}
        ]

        processing_result = data_processor_instance.process_batch_records(invalid_records)

        assert processing_result['error_count'] == 1
        assert len(processing_result['processed_items']) == 0
        assert processing_result['success_rate'] == 0.0

    def test_get_processing_summary_returns_stats(self, data_processor_instance):
        summary_data = data_processor_instance.get_processing_summary()

        assert 'total_processed' in summary_data
        assert 'total_failed' in summary_data
        assert 'overall_success_rate' in summary_data
