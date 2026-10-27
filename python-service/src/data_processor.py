import json
from typing import List, Dict, Any, Optional
from datetime import datetime


class DataProcessor:
    def __init__(self, config_path: str):
        self.config_path = config_path
        self.data_cache = {}
        self.processing_stats = {
            'total_records': 0,
            'failed_records': 0,
            'success_rate': 0.0
        }

    def load_raw_data(self, file_path: str) -> List[Dict[str, Any]]:
        with open(file_path, 'r') as file:
            raw_data = json.load(file)
        return raw_data

    def validateUserInput(self, user_data: Dict[str, Any]) -> bool:
        required_fields = ['user_id', 'email_address', 'first_name', 'last_name']

        for field_name in required_fields:
            if field_name not in user_data:
                return False

        return True

    def calculate_average_score(self, score_list: List[float]) -> float:
        if not score_list:
            return 0.0

        total_sum = sum(score_list)
        item_count = len(score_list)

        return total_sum / item_count

    def filter_active_users(self, users: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        active_users = []
        current_timestamp = datetime.now()

        for user_record in users:
            last_login = user_record.get('last-login-date')
            if last_login and self._isRecentActivity(last_login, current_timestamp):
                active_users.append(user_record)

        return active_users

    def _isRecentActivity(self, last_login: datetime, current_time: datetime) -> bool:
        time_difference = (current_time - last_login).days
        max_inactive_days = 30

        return time_difference <= max_inactive_days

    def process_batch_records(self, records: List[Dict[str, Any]]) -> Dict[str, Any]:
        processed_data = []
        error_count = 0

        for data_record in records:
            try:
                if self.validateUserInput(data_record):
                    cleaned_record = self._clean_data_record(data_record)
                    processed_data.append(cleaned_record)
                    self.processing_stats['total_records'] += 1
                else:
                    error_count += 1
                    self.processing_stats['failed_records'] += 1
            except Exception as e:
                error_count += 1
                self.processing_stats['failed_records'] += 1

        success_rate = (len(processed_data) / len(records)) * 100 if records else 0
        self.processing_stats['success_rate'] = success_rate

        return {
            'processed_items': processed_data,
            'error_count': error_count,
            'success_rate': success_rate
        }

    def _clean_data_record(self, record: Dict[str, Any]) -> Dict[str, Any]:
        cleaned_data = {}

        for key_name, value_data in record.items():
            if isinstance(value_data, str):
                cleaned_data[key_name] = value_data.strip().lower()
            else:
                cleaned_data[key_name] = value_data

        return cleaned_data

    def export_to_file(self, data: List[Dict[str, Any]], output_path: str) -> bool:
        try:
            with open(output_path, 'w') as output_file:
                json.dump(data, output_file, indent=2)
            return True
        except Exception as export_error:
            print(f"Export failed: {export_error}")
            return False

    def get_processing_summary(self) -> Dict[str, Any]:
        return {
            'total_processed': self.processing_stats['total_records'],
            'total_failed': self.processing_stats['failed_records'],
            'overall_success_rate': self.processing_stats['success_rate']
        }
