resource "aws_ecs_task_definition" "legacy_php" {
  family = "legacy-php"
  container_definitions = jsonencode([{
    name  = "legacy-php"
    image = "php:8.1.20-fpm"
    essential = true
  }])
}

resource "aws_ecs_task_definition" "api" {
  family = "api"
  container_definitions = jsonencode([{
    name  = "api"
    image = "${var.registry}/api:${var.api_tag}"
    essential = true
  }])
}
