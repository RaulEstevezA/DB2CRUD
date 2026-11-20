<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('posts', function (Blueprint $table) {
            $table->string('title', 200)->change();
            $table->string('subtitle')->nullable();
            $table->dropColumn('pinned');
        });

        Schema::create('drafts', function (Blueprint $table) {
            $table->id();
        });
        Schema::rename('drafts', 'old_drafts');
        Schema::drop('old_drafts');
    }
};
