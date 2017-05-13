# -*- coding: utf-8 -*-
from __future__ import unicode_literals

from django.shortcuts import render

# Create your views here.
def index(request):
	#setting variables here
	number = 6
	thing = "Eclipse Phase"
	#index.html for our index view
	return render(request, 'index.html', {
		#handing variables to the template index.html here
		'number': number,
		'thing': thing,
		})