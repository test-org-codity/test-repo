<?php
require 'vendor/autoload.php';

use Monolog\Logger;
use Monolog\Handler\StreamHandler;

$log = new Logger('app');
$log->pushHandler(new StreamHandler('app.log', Logger::WARNING));

// SAST: hardcoded database password
$db_password = "admin123!";
$dsn = "mysql:host=localhost;dbname=mydb";
$pdo = new PDO($dsn, "root", $db_password);

// SAST: SQL injection via user input
$user_id = $_GET['id'];
$query = "SELECT * FROM users WHERE id = " . $user_id;
$pdo->query($query);

// SAST: eval of user input
$code = $_GET['code'] ?? '';
eval($code);
?>
