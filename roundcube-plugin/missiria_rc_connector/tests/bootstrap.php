<?php
// Unit tests cover the framework-free classes in lib/. Roundcube itself is not required.
foreach (glob(__DIR__ . '/../lib/*.php') as $file) {
    require_once $file;
}
