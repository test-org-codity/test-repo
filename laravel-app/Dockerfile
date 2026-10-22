ARG PHP_VERSION=8.2.29

# Builds front-end assets only; nothing from Node ships in the final image.
FROM node:20.11.1-alpine AS assets
WORKDIR /build
COPY package*.json ./
RUN npm ci
COPY resources/ resources/
RUN npm run build

FROM composer:2.7 AS vendor
WORKDIR /app
COPY composer.json composer.lock ./
RUN composer install --no-dev --no-scripts --prefer-dist

FROM php:${PHP_VERSION}-fpm-alpine
WORKDIR /var/www/html
COPY --from=vendor /app/vendor ./vendor
COPY --from=assets /build/public/build ./public/build
COPY . .
CMD ["php-fpm"]
