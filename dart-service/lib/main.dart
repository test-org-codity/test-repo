import 'package:http/http.dart' as http;
import 'package:crypto/crypto.dart';
import 'package:logging/logging.dart';
import 'package:dio/dio.dart';
import 'dart:convert';
import 'dart:io';

final _log = Logger('App');

// SAST: hardcoded secret
const String apiKey = 'secret_key_abc123xyz789';

Future<void> main() async {
  Logger.root.level = Level.ALL;

  final dio = Dio();

  // SAST: MD5 weak hashing of password
  final password = 'user_password';
  final bytes = utf8.encode(password);
  final hash = md5.convert(bytes);
  print('Password hash: $hash');

  final response = await http.get(Uri.parse('https://api.example.com/data'),
      headers: {'Authorization': 'Bearer $apiKey'});
  print('Status: ${response.statusCode}');
}
