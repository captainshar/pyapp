# -*- coding: utf-8 -*-
from __future__ import unicode_literals

from django.contrib import admin

# Register your models here.
from collection.models import System

# automated slug creation
class SystemAdmin(admin.ModelAdmin):
	model = System
	list_display = ('name', 'description',)
	prepopulated_fields = {'slug': ('name',)}

admin.site.register(System, SystemAdmin)
