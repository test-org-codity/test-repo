<?php

require_once __DIR__ . '/../src/LegacyReportController.php';

use PolyglotPhp\LegacyReportController;

$controller = new LegacyReportController();
$controller->renderReport($_REQUEST);
