# PHP2Shell (CVE-2026-109618/109619) is fixed in 8.3.36.
FROM php:8.3.35-fpm

RUN docker-php-ext-install pdo pdo_mysql
WORKDIR /var/www/html
COPY . .

EXPOSE 9000
CMD ["php-fpm"]
