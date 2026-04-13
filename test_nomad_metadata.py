#!/usr/bin/env python3
"""Test script to verify NOMAD metadata generation."""

import sys
sys.path.insert(0, '/home/simon/plains/backend')

import json
from app.services.nomad import create_nomad_metadata_yaml
from sqlmodel import create_engine, Session, select
from app.models import Experiment
from  app.core.config import settings

# Create test database session
engine = create_engine(str(settings.SQLALCHEMY_DATABASE_URI), echo=False)

with Session(engine) as session:
    # Get first experiment
    experiment = session.exec(select(Experiment)).first()
    
    if not experiment:
        print("ERROR: No experiments found in database")
        sys.exit(1)
    
    print(f"Found experiment: {experiment.name} (ID: {experiment.id})")
    
    # Call the function
    try:
        metadata_json = create_nomad_metadata_yaml(
            experiment_id=str(experiment.id),
            user_name="Test User",
            session=session
        )
        
        print(f"\n✓ Function returned successfully")
        print(f"  Type: {type(metadata_json)}")
        print(f"  Keys: {list(metadata_json.keys()) if isinstance(metadata_json, dict) else 'Not a dict!'}")
        
        if isinstance(metadata_json, dict):
            print(f"  'data' key present: {'data' in metadata_json}")
            if 'data' in metadata_json:
                print(f"  'data' keys: {list(metadata_json['data'].keys())}")
        
        # Check JSON stringification
        json_str = json.dumps(metadata_json, indent=2)
        print(f"\n✓ JSON stringification successful")
        print(f"  JSON size: {len(json_str)} bytes")
        print(f"\n  First 500 chars:\n{json_str[:500]}...")
        
    except Exception as e:
        print(f"\n✗ Error calling function: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        sys.exit(1)
